/**
 * Talking to an app on this computer over https. A dev server there usually has its own certificate (self-signed,
 * mkcert's, a framework's development one) that nothing else trusts: the studio accepts it, as the developer did in
 * their browser, but only from this computer's own names. A site elsewhere must have a certificate the computer trusts.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/** This computer's own names. */
export const isLoopback = (host: string): boolean => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(host) || /\.localhost$/i.test(host);

/** TLS options for a connection to `url`: a dev server on this computer is accepted with its own certificate. */
export const tlsFor = (url: URL): { rejectUnauthorized?: boolean } => (url.protocol === 'https:' && isLoopback(url.hostname) ? { rejectUnauthorized: false } : {});

const CERT_CODES = /^(?:CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE)|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH)/;

/** What is wrong with a site's certificate, when that is why a request to it failed (fetch puts it in `cause`). */
export function certificateProblem(err: unknown): string | null {
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (typeof e.code === 'string' && CERT_CODES.test(e.code)) return typeof e.message === 'string' ? e.message : e.code;
  }
  return null;
}

interface AppFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual';
}

/**
 * `fetch`, except that an https dev server on this computer is accepted with its own certificate. Redirects are
 * followed (up to 5) unless told not to; the answer's `url` is where it ended.
 */
export async function appFetch(input: string | URL, init: AppFetchInit = {}): Promise<Response> {
  let url = new URL(input);
  for (let hops = 0; ; hops++) {
    if (!(url.protocol === 'https:' && isLoopback(url.hostname))) {
      return fetch(url, hops ? { ...init, method: 'GET', body: undefined } : init);
    }
    const res = await request(url, hops ? { ...init, method: 'GET', body: undefined } : init);
    const location = res.headers.get('location');
    if (init.redirect === 'manual' || !location || res.status < 300 || res.status > 399 || hops >= 5) return res;
    await res.body?.cancel();
    url = new URL(location, url);
  }
}

/** One request with Node's https, as a fetch Response. */
function request(url: URL, init: AppFetchInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? 'GET', headers: init.headers, signal: init.signal, ...tlsFor(url) }, (up: http.IncomingMessage) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(up.headers)) for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, value);
      const status = up.statusCode ?? 502;
      const empty = status === 204 || status === 304 || init.method === 'HEAD';
      if (empty) up.resume();
      const res = new Response(empty ? null : (Readable.toWeb(up) as ReadableStream), { status, statusText: up.statusMessage, headers });
      Object.defineProperty(res, 'url', { value: url.href });
      resolve(res);
    });
    req.on('error', (err) => reject(err.name === 'AbortError' && init.signal?.reason instanceof Error ? init.signal.reason : err));
    req.end(init.body);
  });
}
