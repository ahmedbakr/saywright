/**
 * Shows any app in the studio, whatever its framework, and any deployed site:
 * it is served through a local proxy that adds the studio's bridge to its
 * pages. Each app gets its own port on localhost (kept from one run to the
 * next, and when the app's own port moves), so it is its own origin (storage,
 * service workers) but the same site as the studio: its cookies are sent in
 * the studio's frame and logins work.
 *
 * Cookies ignore ports, so each app's cookies are kept under its own name
 * prefix (ds<port>~name): the app and its scripts see their own names, and
 * never another app's cookies. An app on this computer that calls another
 * port of it (its API) has those requests passed on too, from the app's own
 * address, so the API's CORS rules apply as they do outside the studio; only
 * the page the proxy shows can ask for that. Responses: framing headers and CSP go, cookies
 * stay on localhost, redirects within the site stay in the proxy, and the
 * bridge is the first thing in a page's <head>. Everything streams through,
 * pages too (rewritten as they come), so streamed server rendering shows
 * progressively.
 *
 * What can't work through any proxy: signing in on another site (OAuth, SSO
 * return to the real address), bot walls, keys locked to the real domain,
 * service workers. The studio says so when it sees them.
 */
import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { PROXY_CREDENTIALS_HEADER as CREDENTIALS_HEADER } from '@saywright/vite/protocol';
import { relay } from '../streams.ts';
import { certificateProblem, isLoopback, tlsFor } from './local-tls.ts';
import { freePort } from './runner.ts';

interface ProxyOptions {
  /** The studio's address, for the bridge script. */
  studio: () => string;
  /** First port to give an app. */
  port?: number;
  /** Where the app → port map is kept, so each app keeps its port (and its storage) across runs. */
  stateFile?: string;
  /** How long a request waits for the app to start answering (5 minutes). */
  answerMs?: number;
  /** A line for the app's notes (its log in the app list), for `key` (`<app id>/<env id>`). */
  note?: (key: string, text: string) => void;
}

/**
 * How long the proxy waits for an app to start answering a request: as long as a browser waits (minutes), so a slow
 * export or AI answer arrives. Once it answers, the answer is never cut for being quiet (an event stream, a long poll).
 */
const ANSWER_MS = 5 * 60_000;

interface Target {
  key: string;
  /** Notes already written for it, once each. */
  noted: Set<string>;
  upstream: URL;
  port: number;
  server: http.Server | null;
  server6: http.Server | null;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
/** Response headers that would stop the page loading in the studio, clear the studio's data, or report to the real site. */
const DROP_RESPONSE = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'strict-transport-security',
  'clear-site-data',
  'report-to',
  'reporting-endpoints',
  'nel',
  'alt-svc',
  'public-key-pins',
]);

// Node 22.15 and later decode zstd; elsewhere the proxy doesn't ask for it.
const zstd = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
const ACCEPT_ENCODING = zstd ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br';

/** This site's cookies, as the browser keeps them: under a prefix only this port uses. */
const cookiePrefix = (port: number) => `ds${port}~`;

/**
 * Set-Cookie for the proxy: renamed into the site's namespace, no Domain, no Secure (http://localhost), SameSite=None →
 * Lax. From the site's API on another port, `under` is that port's path in the proxy: a cookie for a path of the API
 * moves under it, and one for / stays the whole site's, as cookies on one host are.
 */
export function rewriteSetCookie(cookie: string, port: number, under?: string): string {
  const [pair, ...attrs] = cookie.split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return cookie;
  const name = pair.slice(0, eq).trim();
  const out = attrs
    .map((a) => a.trim())
    .filter((a) => a && !/^(domain|secure|partitioned)\b/i.test(a))
    .map((a) => (/^samesite\s*=\s*none$/i.test(a) ? 'SameSite=Lax' : a))
    .map((a) => {
      const path = under && /^path\s*=\s*(.*)$/i.exec(a)?.[1].trim();
      return path && path !== '/' && path.startsWith('/') ? `Path=${under}${path}` : a;
    });
  return [`${cookiePrefix(port)}${name}=${pair.slice(eq + 1).trim()}`, ...out].join('; ');
}

/** The Cookie header the site gets: only its own cookies, under their own names. */
export function restoreCookieHeader(header: string, port: number): string {
  const prefix = cookiePrefix(port);
  return header
    .split(/;\s*/)
    .filter((kv) => kv.startsWith(prefix))
    .map((kv) => kv.slice(prefix.length))
    .join('; ');
}

/** A redirect to the site itself stays in the proxy; one elsewhere (a sign-in page) leaves it. */
export function rewriteLocation(location: string, upstream: URL, proxyOrigin: string): string {
  try {
    const to = new URL(location, upstream);
    if (to.origin !== upstream.origin) return location;
    return proxyOrigin + to.pathname + to.search + to.hash;
  } catch {
    return location;
  }
}

const RESOURCE_ATTRS = /(<(?:script|img|source|video|audio|track|embed|iframe|input)\b[^>]*?\s(?:src|srcset|poster)\s*=\s*["'])([^"']*)/gi;
const RESOURCE_LINKS = /(<link\b(?=[^>]*\brel\s*=\s*["']?(?:stylesheet|preload|modulepreload|prefetch|icon|shortcut icon|apple-touch-icon|manifest)\b)[^>]*?\shref\s*=\s*["'])([^"']*)/gi;
const FORM_ATTRS = /(<(?:form|button|input)\b[^>]*?\s(?:action|formaction)\s*=\s*["'])([^"']*)/gi;

interface PageContext {
  upstream: URL;
  proxyOrigin: string;
  studio: string;
  port: number;
}

/**
 * The page's own CSP meta tags out, and the site's absolute addresses in resource tags and forms (they load and post
 * through the proxy, so cookies and CORS behave). Links, canonical, hreflang, Open Graph and JSON-LD stay as written:
 * audits read them, and the bridge keeps clicks and navigations in the proxy.
 */
function rewriteTags(html: string, ctx: PageContext): string {
  const origin = ctx.upstream.origin;
  const bare = `//${ctx.upstream.host}`;
  const swap = (url: string) => (url.startsWith(origin) ? ctx.proxyOrigin + url.slice(origin.length) : url.startsWith(bare) ? ctx.proxyOrigin + url.slice(bare.length) : url.split(`${origin}/`).join(`${ctx.proxyOrigin}/`));
  let out = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?[^>]*>/gi, '');
  // The page's own tag for the studio's script (from a script-tag connection, perhaps to another studio address) never
  // runs: the proxy's bridge does. The element stays, without its address, so a framework hydrating the page finds it.
  out = out.replace(/(<script\b[^>]*?\s)src(\s*=\s*["']?[^"'\s>]*\/saywright\.js\b)/gi, '$1data-saywright-src$2');
  out = out.replace(RESOURCE_ATTRS, (_m, head: string, url: string) => head + swap(url));
  out = out.replace(RESOURCE_LINKS, (_m, head: string, url: string) => head + swap(url));
  out = out.replace(FORM_ATTRS, (_m, head: string, url: string) => head + swap(url));
  // A <base> at the site's own address would send every relative address there.
  out = out.replace(/(<base\b[^>]*?\shref\s*=\s*["'])([^"']*)/i, (_m, head: string, url: string) => head + swap(url));
  out = out.replace(/(<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*)([^"'>]+)/i, (_m, head: string, url: string) => head + swap(url));
  return out;
}

/** The bridge, and what it needs to know about the proxy it is shown through. */
function bridge(ctx: PageContext): string {
  const config = JSON.stringify({ upstream: ctx.upstream.origin, proxy: ctx.proxyOrigin, cookies: cookiePrefix(ctx.port), studio: ctx.studio }).replace(/</g, '\\u003c');
  return `<script>window.__SAYWRIGHT_PROXY__=${config}</script><script src="${ctx.studio}/saywright.js"></script>`;
}

/**
 * A page as it streams through: rewritten a whole tag at a time (a tag cut between two chunks waits for its end),
 * with the bridge first in <head>. Until the bridge is in, the page is held back; it usually is in the first chunk.
 */
export class PageRewriter {
  private open = '';
  private held = '';
  private placed = false;

  constructor(private ctx: PageContext) {}

  /** What can be sent of the page so far, with `text` added to it. */
  push(text: string): string {
    const all = this.open + text;
    const start = all.lastIndexOf('<');
    const cut = start >= 0 && all.indexOf('>', start) < 0 && all.length - start < 16_384 ? start : all.length;
    this.open = all.slice(cut);
    return this.send(rewriteTags(all.slice(0, cut), this.ctx), false);
  }

  /** The rest of the page, once it has all arrived. */
  end(): string {
    const last = rewriteTags(this.open, this.ctx);
    this.open = '';
    return this.send(last, true);
  }

  private send(text: string, end: boolean): string {
    if (this.placed) return text;
    const page = this.held + text;
    const head = /<head\b[^>]*>/i.exec(page);
    // A page without <head> before its body (or in its first 64 KB) gets the bridge first all the same.
    if (!head && !end && !/<body\b|<\/head>/i.test(page) && page.length < 65_536) {
      this.held = page;
      return '';
    }
    this.placed = true;
    this.held = '';
    const tag = bridge(this.ctx);
    if (head) return page.slice(0, head.index + head[0].length) + tag + page.slice(head.index + head[0].length);
    const html = /<html\b[^>]*>/i.exec(page);
    if (html) return `${page.slice(0, html.index + html[0].length)}<head>${tag}</head>${page.slice(html.index + html[0].length)}`;
    // After the doctype: anything before it would put the page in quirks mode.
    const at = /^\s*<!doctype[^>]*>/i.exec(page)?.[0].length ?? 0;
    return page.slice(0, at) + tag + page.slice(at);
  }
}

/** The bridge first in <head>, and the page's tags rewritten (see rewriteTags), for a page that is all here. */
export function transformHtml(html: string, ctx: PageContext): string {
  const page = new PageRewriter(ctx);
  return page.push(html) + page.end();
}

/** Text as it streams through with one string replaced by another, also where a chunk ends in the middle of it. */
export class TextReplacer {
  private held = '';

  constructor(
    private from: string,
    private to: string,
  ) {}

  push(text: string): string {
    const all = this.held + text;
    // The last few characters may be the start of `from`: they wait for the next chunk, unless `from` ends there.
    let cut = Math.max(0, all.length - this.from.length + 1);
    const at = all.indexOf(this.from, Math.max(0, cut - this.from.length + 1));
    if (at >= 0 && at < cut) cut = at + this.from.length;
    this.held = all.slice(cut);
    return all.slice(0, cut).split(this.from).join(this.to);
  }

  end(): string {
    const rest = this.held.split(this.from).join(this.to);
    this.held = '';
    return rest;
  }
}

const CHUNK = 64 * 1024;

/** The streams that decode a response's body: none when it isn't encoded, null when it can't be decoded here. */
function decoders(encoding: string | undefined): Transform[] | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return [];
    case 'gzip':
    case 'x-gzip':
    case 'deflate':
      // Unzip reads gzip and zlib's deflate alike. Larger pieces than zlib's usual 16 KB: fewer, faster rewrites.
      return [zlib.createUnzip({ chunkSize: CHUNK })];
    case 'br':
      return [zlib.createBrotliDecompress({ chunkSize: CHUNK })];
    case 'zstd':
      return zstd ? [zstd()] : null;
    default:
      return null;
  }
}

/**
 * Whether a page's bytes are UTF-16 (its header says so, or it starts with a UTF-16 byte order mark): the one encoding
 * a page is found in whose tags aren't ASCII bytes, so the studio's script can't be spliced in.
 */
function utf16(type: string, first: Buffer): boolean {
  return /charset\s*=\s*["']?utf-16/i.test(type) || (first.length >= 2 && ((first[0] === 0xff && first[1] === 0xfe) || (first[0] === 0xfe && first[1] === 0xff)));
}

/** Whether an Accept-Encoding header accepts `encoding` (a q of 0 refuses it). */
export function acceptsEncoding(header: string | string[] | undefined, encoding: string): boolean {
  const enc = encoding.trim().toLowerCase();
  if (!enc || enc === 'identity') return true;
  const offers = String(header ?? '')
    .split(',')
    .map((part) => {
      const [name, ...params] = part.trim().toLowerCase().split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)/.exec(p)?.[1]).find(Boolean);
      return { name: name.trim() === 'x-gzip' ? 'gzip' : name.trim(), ok: q === undefined || Number(q) > 0 };
    });
  const named = offers.find((o) => o.name === (enc === 'x-gzip' ? 'gzip' : enc));
  return named ? named.ok : !!offers.find((o) => o.name === '*')?.ok;
}

/** A page being loaded (as opposed to HTML fetched by a script, which must stay as the site sent it). */
function isNavigation(req: IncomingMessage): boolean {
  const dest = String(req.headers['sec-fetch-dest'] ?? '');
  const mode = String(req.headers['sec-fetch-mode'] ?? '');
  if (dest || mode) return dest === 'document' || dest === 'iframe' || mode === 'navigate';
  return /text\/html/.test(String(req.headers.accept ?? ''));
}

/**
 * The address on the linked site that a request asks for, or null when the request names another host (an absolute
 * address, `//host/…` or `/\\host/…`): the proxy would otherwise fetch any site or internal address for any page it
 * shows (SSRF).
 */
export function upstreamUrl(raw: string | undefined, upstream: URL): URL | null {
  const p = raw ?? '/';
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return null;
  const url = new URL(upstream.origin + p);
  return url.origin === upstream.origin ? url : null;
}

/** This computer's own names. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
/**
 * The proxy's path for another port of this computer: /__saywright/<http|https>[+cred]/<host>:<port><path>. `+cred`:
 * the page sent the request with its credentials (fetch's credentials: 'include', an event stream's withCredentials).
 */
const VIA = /^\/__saywright\/(https?)(\+cred)?\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(\/.*)?$/s;

/**
 * The address on this computer that a request to the proxy's path for another port stands for (the site's API), or
 * null: for a site on this computer only, on this computer's own names only, and never one of `refused` (the proxy's
 * own ports, the studio's).
 */
export function viaUrl(raw: string | undefined, upstream: URL, refused: ReadonlySet<number>): URL | null {
  return viaRequest(raw, upstream, refused)?.url ?? null;
}

/** The same, and whether the page sent it with its credentials (see VIA). */
export function viaRequest(raw: string | undefined, upstream: URL, refused: ReadonlySet<number>): { url: URL; credentials: boolean } | null {
  const m = VIA.exec(raw ?? '');
  if (!m || !LOOPBACK.test(upstream.hostname)) return null;
  const port = Number(m[4]);
  const rest = m[5] ?? '/';
  if (!port || port > 65535 || refused.has(port) || rest.startsWith('//') || rest.startsWith('/\\')) return null;
  return { url: new URL(`${m[1]}://${m[3]}:${port}${rest}`), credentials: !!m[2] };
}

/** Request headers the browser sets itself, or a page may not: none of them asks the API's leave first. */
const BROWSER_SET = new Set(['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent', 'priority', 'pragma', 'cache-control', CREDENTIALS_HEADER]);
const SIMPLE_TYPE = /^(?:application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\s*(?:;|$)/i;

/**
 * What a request the page made to another origin must have its API allow before it is sent (the browser's
 * preflight), as the browser decides: a method other than GET, HEAD or POST, or a header of the page's own beyond
 * the few any page may send. Null: a simple request, sent as it is.
 */
export function preflightFor(method: string, headers: IncomingHttpHeaders): { method: string; headers: string[] } | null {
  const own = Object.keys(headers)
    .filter((h) => !BROWSER_SET.has(h) && !h.startsWith('sec-') && !h.startsWith('proxy-'))
    .filter((h) => !['accept', 'accept-language', 'content-language', 'content-type'].includes(h) || (h === 'content-type' && !SIMPLE_TYPE.test(String(headers[h]))))
    .sort();
  return ['GET', 'HEAD', 'POST'].includes(method) && !own.length ? null : { method, headers: own };
}

/** Whether an API's answer may be read by a page of `origin`, by its CORS headers, as the browser decides. */
export function corsAllows(headers: IncomingHttpHeaders, origin: string, credentials: boolean): boolean {
  const allow = headers['access-control-allow-origin'];
  if (allow === origin) return !credentials || headers['access-control-allow-credentials'] === 'true';
  return allow === '*' && !credentials;
}

/** Whether an API's answer to a preflight lets the request through. */
export function preflightAllows(status: number, headers: IncomingHttpHeaders, want: { method: string; headers: string[] }, origin: string, credentials: boolean): boolean {
  if (status < 200 || status > 299 || !corsAllows(headers, origin, credentials)) return false;
  const list = (h: string | string[] | undefined) => String(h ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const methods = list(headers['access-control-allow-methods']);
  const allowed = list(headers['access-control-allow-headers']);
  const method = ['GET', 'HEAD', 'POST'].includes(want.method) || methods.includes(want.method.toLowerCase()) || (!credentials && methods.includes('*'));
  return method && want.headers.every((h) => allowed.includes(h) || (!credentials && allowed.includes('*') && h !== 'authorization'));
}

/**
 * Whether the page the proxy shows made the request: the browser says so (Sec-Fetch-Site, and Origin when it sends
 * one), and no other site can make it say that. Without either, it is refused.
 */
export function fromPage(headers: IncomingHttpHeaders, proxyOrigin: string): boolean {
  const site = headers['sec-fetch-site'];
  const origin = headers.origin;
  if (site === undefined && origin === undefined) return false;
  return (site === undefined || site === 'same-origin') && (origin === undefined || origin === proxyOrigin);
}

/**
 * Whether the browser would let the page read the answer to this request if it went to the other port itself: only a
 * script's `cors` request (fetch, XHR, an event stream). A `no-cors` fetch, a navigation, or a script, image, style or
 * font loaded from the proxy's path would get the answer as the page's own (same-origin), readable whatever the other
 * service's CORS rules say, so they are never answered. A browser that doesn't say (no Sec-Fetch-Mode) isn't either.
 */
export function readableRequest(headers: IncomingHttpHeaders): boolean {
  const dest = headers['sec-fetch-dest'];
  return headers['sec-fetch-mode'] === 'cors' && (dest === undefined || dest === 'empty');
}

/** Where a request to the API on another port lands in the proxy, for the cookies it sets and its redirects. */
const viaPrefix = (url: URL) => `/__saywright/${url.protocol.slice(0, -1)}/${url.host}`;

export class AppProxy {
  /** Open proxies, by app and address (`<app id>/<env id>`), or by the site's origin when no app is given. */
  private targets = new Map<string, Target>();
  private opening = new Map<string, Promise<Target>>();
  /** Each one's port, kept across runs so each app keeps its storage and cookies. */
  private ports: Record<string, number> = {};

  constructor(private opts: ProxyOptions) {
    try {
      if (opts.stateFile) this.ports = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8')) as Record<string, number>;
    } catch {
      /* first run */
    }
  }

  /**
   * The address to show `upstream` at, for `key` (an app's address): its own port on localhost, the same one each time
   * when it is free. When the app has moved (its port was taken), its proxy stays and points at where it is now.
   */
  async open(upstream: string, key = new URL(upstream).origin): Promise<string> {
    const u = new URL(upstream);
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.target(key, u.origin).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    const target = await pending;
    if (target.upstream.origin !== u.origin) target.upstream = new URL(u.origin);
    return `http://localhost:${target.port}${u.pathname}${u.search}`;
  }

  /** The upstream address a proxied page address stands for. */
  upstreamFor(url: string): string | null {
    try {
      const u = new URL(url);
      for (const t of this.targets.values()) if (String(t.port) === u.port && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return t.upstream.origin + u.pathname + u.search + u.hash;
    } catch {
      /* not a URL */
    }
    return null;
  }

  /** An app is removed from the studio: its proxies close and their ports are free for others. */
  release(app: string): void {
    const mine = (key: string) => key.startsWith(`${app}/`);
    for (const [key, t] of this.targets) {
      if (!mine(key)) continue;
      shut(t);
      this.targets.delete(key);
    }
    const kept = Object.keys(this.ports).filter(mine);
    for (const key of kept) delete this.ports[key];
    if (kept.length) this.save();
  }

  private async target(key: string, origin: string): Promise<Target> {
    const existing = this.targets.get(key);
    if (existing?.server) return existing;
    // Its port from before; earlier versions kept one per address, so the app's address may hold it.
    const before = this.ports[key] === undefined && key !== origin && this.ports[origin] !== undefined ? origin : null;
    const wanted = this.ports[key] ?? (before ? this.ports[before] : undefined);
    const taken = new Set([...this.targets.values()].map((t) => t.port));
    let port = wanted && !taken.has(wanted) ? await freePort(wanted).then((p) => (p === wanted ? p : 0)) : 0;
    if (!port) {
      let from = this.opts.port ?? 5281;
      while (taken.has(from) || Object.values(this.ports).includes(from)) from++;
      port = await freePort(from);
    }
    const target: Target = { key, noted: new Set(), upstream: new URL(origin), port, server: null, server6: null };
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.handle(target, req, res);
    const server = http.createServer(handler);
    server.on('upgrade', (req, socket, head) => this.upgrade(target, req, socket as net.Socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    target.server = server;
    // Browsers may try ::1 first for localhost: answer there too when the machine has IPv6. Kept from the start, not
    // once it listens, so an app removed meanwhile closes it too (a close before it listens cancels the listen).
    const server6 = http.createServer(handler);
    server6.on('upgrade', (req, socket, head) => this.upgrade(target, req, socket as net.Socket, head));
    server6.once('error', () => {
      if (target.server6 === server6) target.server6 = null;
    });
    target.server6 = server6;
    server6.listen(port, '::1');
    this.targets.set(key, target);
    if (before) delete this.ports[before];
    if (this.ports[key] !== port || before) {
      this.ports[key] = port;
      this.save();
    }
    return target;
  }

  /** The map, written whole: a new file renamed over the old one, so a crash mid-write can't leave half of it. */
  private save(): void {
    if (!this.opts.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      const tmp = `${this.opts.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.ports, null, 1));
      fs.renameSync(tmp, this.opts.stateFile);
    } catch {
      /* the map is a convenience */
    }
  }

  private requestHeaders(req: IncomingMessage, target: Target, proxyOrigin: string): IncomingHttpHeaders {
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    headers.host = target.upstream.host;
    // The site checks where requests come from (CSRF): from itself, as far as it can tell.
    for (const k of ['origin', 'referer'] as const) {
      const v = headers[k];
      if (typeof v === 'string') headers[k] = v.split(proxyOrigin).join(target.upstream.origin);
    }
    const cookie = typeof headers.cookie === 'string' ? restoreCookieHeader(headers.cookie, target.port) : '';
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    // What the proxy decodes itself (pages, styles) may come in any encoding it reads; everything else goes to the
    // browser as it comes, so only in an encoding the browser asked for.
    if (isNavigation(req) || req.headers['sec-fetch-dest'] === 'style') headers['accept-encoding'] = ACCEPT_ENCODING;
    else if (!req.headers['accept-encoding']) delete headers['accept-encoding'];
    // A page is always fetched in full, so it always gets the current bridge.
    if (isNavigation(req)) {
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
    return headers;
  }

  private async handle(target: Target, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    // Only this computer's own names (another name pointing here is someone else's page: DNS rebinding).
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('This proxy answers on localhost only.');
    }
    // Service workers would cache pages without the bridge: never installed through the proxy.
    if (req.headers['service-worker'] === 'script') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return void res.end('Service workers are off while the studio shows this site.');
    }
    const proxyOrigin = `http://localhost:${target.port}`;
    if (req.url?.startsWith('/__saywright/')) return this.via(target, req, res, proxyOrigin);
    const url = upstreamUrl(req.url, target.upstream);
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('This proxy only fetches pages of the site it shows.');
    }
    const lib = url.protocol === 'https:' ? https : http;
    const upstreamReq = lib.request(
      url,
      // A dev server on this computer is accepted with its own certificate, as the developer accepted it in their browser.
      { method: req.method, headers: this.requestHeaders(req, target, proxyOrigin), servername: url.hostname, ...tlsFor(url) },
      (up) => this.answer(up, res, () => this.respond(target, req, up, res, proxyOrigin)),
    );
    untilGone(res, upstreamReq);
    this.answerWithin(upstreamReq);
    upstreamReq.on('error', (err) => {
      // The browser went first (it cancelled, or reloaded): no one to tell.
      if (res.destroyed) return;
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      const cert = certificateProblem(err);
      const [title, advice] = cert
        ? [`${target.upstream.origin}’s certificate isn’t trusted`, 'This computer doesn’t trust the certificate it sent, so the studio doesn’t show it (it accepts a development certificate only from an app on this computer).']
        : [`${target.upstream.origin} didn’t answer`, 'Check that it is running, then reload.'];
      res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:32px;color:#333"><h2 style="margin:0 0 8px">${title}</h2><p>${String(cert ?? err.message).replace(/[<>&]/g, '')}</p><p>${advice}</p>`);
    });
    req.pipe(upstreamReq);
  }

  /** Ports a request may never be passed on to: the proxies' own, and the studio's. */
  private refused(): Set<number> {
    const ports = new Set([...this.targets.values()].map((t) => t.port));
    try {
      const studio = new URL(this.opts.studio());
      ports.add(Number(studio.port) || 80);
    } catch {
      /* no studio address yet */
    }
    return ports;
  }

  /**
   * A request the page made to another port of this computer (its API), passed on as it would go outside the studio:
   * from the site's own address, with the site's cookies. As the browser would see it, a request nothing answers
   * fails rather than getting an error page.
   */
  private via(target: Target, req: IncomingMessage, res: ServerResponse, proxyOrigin: string): void {
    const found = viaRequest(req.url, target.upstream, this.refused());
    if (!found || !fromPage(req.headers, proxyOrigin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('This proxy passes requests on to another port of this computer for the page it shows, and only for it.');
    }
    // Anything but a script's cors request would hand the page another service's answer as its own: an empty answer,
    // and nothing is sent. (The bridge lets the browser send a no-cors request to the other port itself.)
    if (!readableRequest(req.headers)) {
      req.resume();
      res.writeHead(403, { 'X-Saywright-Blocked': 'no-cors', 'Cache-Control': 'no-store' });
      return void res.end();
    }
    const { url } = found;
    const credentials = found.credentials || req.headers[CREDENTIALS_HEADER] === 'include';
    const origin = target.upstream.origin;
    const headers = this.requestHeaders(req, target, proxyOrigin);
    headers.host = url.host;
    delete headers[CREDENTIALS_HEADER];
    // As the browser sends a request to another origin: from the site's own address, a site of the same computer,
    // and with the site's cookies only when the page sent its credentials.
    headers.origin = origin;
    headers['sec-fetch-site'] = 'same-site';
    if (!credentials) delete headers.cookie;
    // Its answer goes to the browser as it comes: in an encoding the browser asked for.
    if (req.headers['accept-encoding']) headers['accept-encoding'] = req.headers['accept-encoding'];
    else delete headers['accept-encoding'];
    const secure = url.protocol === 'https:';
    const lib = secure ? https : http;
    // This computer's own API often has a self-signed development certificate; the connection never leaves the computer.
    const tlsOptions = secure ? { ...tlsFor(url), servername: url.hostname === 'localhost' ? 'localhost' : undefined } : {};
    // What the API's CORS rules don't let a page of the site read, the page doesn't get: as in the site's own tab.
    const blocked = (why: string) => {
      if (res.destroyed) return;
      if (res.headersSent) return void res.destroy();
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Saywright-Blocked': 'cors' });
      res.end(`Blocked as the browser blocks it outside the studio: ${why}`);
    };
    const send = () => {
      if (res.destroyed) return;
      const upstreamReq = lib.request(url, { method: req.method, headers, ...tlsOptions }, (up) =>
        this.answer(up, res, () => {
          if (!corsAllows(up.headers, origin, credentials)) {
            up.resume();
            return blocked(`${url.host} doesn’t let pages of ${origin} read what it answers${credentials ? ' with their cookies' : ''} (CORS).`);
          }
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(up.headers)) {
            if (v === undefined || HOP.has(k) || DROP_RESPONSE.has(k)) continue;
            if (k === 'set-cookie') out[k] = (Array.isArray(v) ? v : [v]).map((c) => rewriteSetCookie(c, target.port, viaPrefix(url)));
            else if (k === 'location') out[k] = this.viaLocation(String(v), url, target, proxyOrigin);
            else out[k] = v;
          }
          res.writeHead(up.statusCode ?? 502, out);
          relay(up, res);
        }),
      );
      untilGone(res, upstreamReq);
      this.answerWithin(upstreamReq);
      upstreamReq.on('error', () => res.destroy());
      req.pipe(upstreamReq);
    };
    const want = preflightFor(req.method ?? 'GET', req.headers);
    if (!want) return send();
    // Asked first, as the browser asks: the request is sent only if the API allows it.
    const ask: IncomingHttpHeaders = { host: url.host, origin, 'access-control-request-method': want.method, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
    if (want.headers.length) ask['access-control-request-headers'] = want.headers.join(',');
    if (req.headers['user-agent']) ask['user-agent'] = req.headers['user-agent'];
    const pre = lib.request(url, { method: 'OPTIONS', headers: ask, ...tlsOptions }, (up) =>
      this.answer(up, res, () => {
        up.resume();
        if (preflightAllows(up.statusCode ?? 0, up.headers, want, origin, credentials)) send();
        else blocked(`${url.host} doesn’t allow a ${want.method} request${want.headers.length ? ` with ${want.headers.join(', ')}` : ''} from ${origin} (CORS).`);
      }),
    );
    untilGone(res, pre);
    this.answerWithin(pre);
    pre.on('error', () => res.destroy());
    pre.end();
  }

  /** A request to the app ends when the app hasn't started answering it in time (see ANSWER_MS); never after. */
  private answerWithin(upstreamReq: http.ClientRequest): void {
    const ms = this.opts.answerMs ?? ANSWER_MS;
    const limit = ms % 60_000 ? `${Math.round(ms / 1000)} seconds` : `${ms / 60_000} minutes`;
    const timer = setTimeout(() => upstreamReq.destroy(new Error(`It didn’t start answering within ${limit}.`)), ms);
    timer.unref();
    upstreamReq.once('response', () => clearTimeout(timer));
    upstreamReq.once('close', () => clearTimeout(timer));
  }

  /** A redirect from the API: to itself, it stays on its path in the proxy; to the site, in the proxy; elsewhere, as sent. */
  private viaLocation(location: string, api: URL, target: Target, proxyOrigin: string): string {
    try {
      const to = new URL(location, api);
      if (to.origin === api.origin) return proxyOrigin + viaPrefix(api) + to.pathname + to.search + to.hash;
    } catch {
      return location;
    }
    return rewriteLocation(location, target.upstream, proxyOrigin);
  }

  /**
   * What to do with the site's answer, once it comes: nothing when the browser has gone meanwhile (the site's answer is
   * let go), and never a thrown error, which would end the studio.
   */
  private answer(up: IncomingMessage, res: ServerResponse, handle: () => void): void {
    if (res.destroyed || res.writableEnded) return void up.destroy();
    try {
      handle();
    } catch {
      up.destroy();
      res.destroy();
    }
  }

  private respond(target: Target, req: IncomingMessage, up: IncomingMessage, res: ServerResponse, proxyOrigin: string): void {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) {
      if (v === undefined || HOP.has(k) || DROP_RESPONSE.has(k)) continue;
      if (k === 'set-cookie') headers[k] = (Array.isArray(v) ? v : [v]).map((c) => rewriteSetCookie(c, target.port));
      else if (k === 'location' || k === 'content-location') headers[k] = rewriteLocation(String(v), target.upstream, proxyOrigin);
      else if (k === 'refresh') headers[k] = String(v).replace(/(url\s*=\s*)(\S+)/i, (_m, h: string, u: string) => h + rewriteLocation(u, target.upstream, proxyOrigin));
      else if (k === 'link') headers[k] = String(v).split(target.upstream.origin).join(proxyOrigin);
      else headers[k] = v;
    }
    const type = String(up.headers['content-type'] ?? '');
    const html = /^(text\/html|application\/xhtml\+xml)/i.test(type) && isNavigation(req);
    const css = /^text\/css/i.test(type);
    // Anything else, and what can't be decoded here, passes as the site sent it: decoded only when it came in an
    // encoding the browser didn't ask for (a server that compresses whatever it is asked).
    const encoding = String(up.headers['content-encoding'] ?? '');
    const unasked = !acceptsEncoding(req.headers['accept-encoding'], encoding);
    const decode = html || css || unasked ? decoders(encoding) : null;
    const empty = req.method === 'HEAD' || up.statusCode === 204 || up.statusCode === 304;
    if (decode && unasked && !html && !css && !empty) {
      for (const h of ['content-encoding', 'content-length']) delete headers[h];
      res.writeHead(up.statusCode ?? 200, headers);
      relay(up, res, ...decode);
      return;
    }
    if (!decode || !(html || css) || empty) {
      res.writeHead(up.statusCode ?? 502, headers);
      relay(up, res);
      return;
    }
    // Pages and styles are rewritten as they arrive: streamed server rendering shows as it comes.
    const rewrite = html ? new PageRewriter({ upstream: target.upstream, proxyOrigin, studio: this.opts.studio(), port: target.port }) : new TextReplacer(target.upstream.origin, proxyOrigin);
    for (const h of ['content-encoding', 'content-length', 'etag', 'last-modified']) delete headers[h];
    if (html) headers['cache-control'] = 'no-store';
    res.writeHead(up.statusCode ?? 200, headers);
    const note = () => this.note(target, 'utf-16', 'A page of it is in UTF-16, which the studio can’t add its script to: it is shown as it is, and can’t be pointed at or recorded.');
    // Rewritten as bytes: each byte is read as one character (latin1), so the ASCII tags and addresses the rewrite looks
    // for are found in any ASCII-compatible encoding (UTF-8, Windows-125x, Shift_JIS…) and every other byte goes out
    // exactly as it came. The page keeps its own encoding, and its charset (header, <meta>, BOM) stays true. A UTF-16
    // page (decided on its first bytes) passes through untouched.
    let wide: boolean | null = null;
    const bytes = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        if (wide === null && (wide = utf16(type, chunk)) && html) note();
        if (wide) return done(null, chunk);
        const out = rewrite.push(chunk.toString('latin1'));
        done(null, out ? Buffer.from(out, 'latin1') : undefined);
      },
      flush(done) {
        const out = wide ? '' : rewrite.end();
        done(null, out ? Buffer.from(out, 'latin1') : undefined);
      },
    });
    relay(up, res, ...decode, bytes);
  }

  /** A line in the app's notes, once for each reason. */
  private note(target: Target, reason: string, text: string): void {
    if (target.noted.has(reason)) return;
    target.noted.add(reason);
    this.opts.note?.(target.key, text);
  }

  /**
   * WebSockets (live reload, realtime features): a raw tunnel with the host, origin and cookies of the site, to the site
   * itself or, from its own page, to its API on another port of this computer.
   */
  private upgrade(target: Target, req: IncomingMessage, socket: net.Socket, head: Buffer): void {
    const proxyOrigin = `http://localhost:${target.port}`;
    const via = !!req.url?.startsWith('/__saywright/');
    const api = via ? viaUrl(req.url, target.upstream, this.refused()) : null;
    if (via ? !api || !fromPage(req.headers, proxyOrigin) : !upstreamUrl(req.url, target.upstream)) return void socket.destroy();
    const to = api ?? target.upstream;
    const secure = to.protocol === 'https:';
    const port = Number(to.port) || (secure ? 443 : 80);
    const host = to.hostname.replace(/^\[|\]$/g, '');
    // A dev server on this computer (the site or its API) is accepted with its own certificate; a site elsewhere is not.
    const servername = net.isIP(host) ? undefined : host;
    const upstream = secure ? tls.connect({ host, port, servername, rejectUnauthorized: !isLoopback(to.hostname) }) : net.connect({ host, port });
    const path = api ? api.pathname + api.search : req.url;
    upstream.once(secure ? 'secureConnect' : 'connect', () => {
      const headers: IncomingHttpHeaders = { ...req.headers, host: to.host };
      if (typeof headers.origin === 'string') headers.origin = headers.origin.split(proxyOrigin).join(target.upstream.origin);
      if (typeof headers.cookie === 'string') {
        const cookie = restoreCookieHeader(headers.cookie, target.port);
        if (cookie) headers.cookie = cookie;
        else delete headers.cookie;
      }
      let raw = `${req.method} ${path} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) for (const value of Array.isArray(v) ? v : [v]) if (value !== undefined) raw += `${k}: ${value}\r\n`;
      upstream.write(`${raw}\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
  }

  close(): void {
    for (const t of this.targets.values()) shut(t);
    this.targets.clear();
  }
}

/** The browser gave up on its request (a reload, a cancelled fetch, a closed tab): so does the request to the site. */
function untilGone(res: ServerResponse, upstream: http.ClientRequest): void {
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
}

/** A proxy's servers closed, with the connections still open to them (kept alive by browsers). */
function shut(t: Target): void {
  for (const server of [t.server, t.server6]) {
    server?.close();
    server?.closeAllConnections();
  }
  t.server = null;
  t.server6 = null;
}
