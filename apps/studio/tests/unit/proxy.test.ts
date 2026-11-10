/**
 * The proxy that shows any app or deployed site in the studio: each app on
 * its own port (kept across runs, and when the app's own port moves), pages
 * get the bridge, can be framed, keep their cookies apart from other apps',
 * redirect within the proxy, arrive decoded whatever compression the site
 * used, and stream through as the site sends them. Live reload sockets go
 * through. A site on this computer reaches its API on another port through
 * the proxy, from its own address, and nothing else can ask for that.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppProxy, corsAllows, readableRequest, fromPage, PageRewriter, preflightAllows, preflightFor, restoreCookieHeader, rewriteLocation, rewriteSetCookie, TextReplacer, transformHtml, upstreamUrl as targetOf, viaRequest, viaUrl } from '../../server/apps/proxy';
import { probeUrl } from '../../server/apps/detect';
import { certificateProblem, tlsFor } from '../../server/apps/local-tls';

let upstream: http.Server;
let upstreamUrl = '';
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-')), 'ports.json');
const proxy = new AppProxy({ studio: () => 'http://localhost:5173', port: 5480, stateFile });
let frame = '';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>Shop</title>
<link rel="canonical" href="UP/products"><link rel="stylesheet" href="UP/app.css"></head>
<body><a href="UP/about">About</a><img src="UP/logo.png"><p>مرحبا</p></body></html>`;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const page = PAGE.split('UP').join(upstreamUrl);
    if (req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'Set-Cookie': ['sid=abc; Domain=shop.example; Path=/; HttpOnly; Secure; SameSite=Lax', 'theme=dark; Path=/'],
        ETag: '"v1"',
      });
      return res.end(zlib.gzipSync(page));
    }
    if (req.url === '/br') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' });
      return res.end(zlib.brotliCompressSync('<html><head></head><body>brotli</body></html>'));
    }
    if (req.url === '/latin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=windows-1256' });
      // "سلام" in Windows-1256.
      return res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xd3, 0xe1, 0xc7, 0xe3, 0x3c, 0x2f, 0x70, 0x3e]));
    }
    if (req.url === '/login') {
      res.writeHead(302, { Location: `${upstreamUrl}/account?x=1` });
      return res.end();
    }
    if (req.url === '/sso') {
      res.writeHead(302, { Location: 'https://accounts.example.org/auth' });
      return res.end();
    }
    if (req.url === '/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(`@font-face{src:url(${upstreamUrl}/f.woff2)}`);
    }
    if (req.url === '/echo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null }));
    }
    if (req.url === '/blob') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
      return res.end(zlib.gzipSync(Buffer.from([1, 2, 3, 4])));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('missing');
  });
  // A minimal WebSocket echo (handshake, then raw bytes back).
  upstream.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Seen-Host: ${req.headers.host}\r\nX-Seen-Origin: ${req.headers.origin}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
  frame = await proxy.open(`${upstreamUrl}/`);
});

afterAll(() => {
  proxy.close();
  upstream.close();
});

/** A request to the proxy, as the browser in the studio makes it. */
function get(route: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const u = new URL(frame);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: route, headers: { host: u.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the app proxy', () => {
  it('gives each site its own port on localhost, and the same one next time', async () => {
    expect(frame).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect(proxy.upstreamFor(`${new URL(frame).origin}/products?a=1`)).toBe(`${upstreamUrl}/products?a=1`);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ [upstreamUrl]: Number(new URL(frame).port) });
    expect(await proxy.open(`${upstreamUrl}/cart`)).toBe(`${new URL(frame).origin}/cart`);
  });

  it('adds the bridge first in <head>, lets the page be framed, and serves it decoded and fresh', async () => {
    const r = await get('/', { accept: 'text/html', 'if-none-match': '"v1"' });
    expect(r.status).toBe(200);
    const html = r.body.toString('utf8');
    expect(html).toMatch(/<head><script>window\.__SAYWRIGHT_PROXY__=\{"upstream":"http:\/\/127\.0\.0\.1:\d+","proxy":"http:\/\/localhost:\d+","cookies":"ds\d+~","studio":"http:\/\/localhost:5173"\}<\/script><script src="http:\/\/localhost:5173\/saywright\.js"><\/script><meta charset/);
    expect(html).not.toMatch(/Content-Security-Policy/i);
    expect(r.headers['x-frame-options']).toBeUndefined();
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.etag).toBeUndefined();
    // Streamed as it is rewritten: no length known up front.
    expect(r.headers['content-length']).toBeUndefined();
    expect(r.headers['transfer-encoding']).toBe('chunked');
    expect(html).toContain('مرحبا');
    // Resources load through the proxy; links, canonical and the like stay as the site wrote them.
    const origin = new URL(frame).origin;
    expect(html).toContain(`<link rel="stylesheet" href="${origin}/app.css">`);
    expect(html).toContain(`<img src="${origin}/logo.png">`);
    expect(html).toContain(`<link rel="canonical" href="${upstreamUrl}/products">`);
    expect(html).toContain(`<a href="${upstreamUrl}/about">`);
  });

  it('keeps each site’s cookies under its own prefix on localhost', async () => {
    const port = Number(new URL(frame).port);
    const r = await get('/');
    expect(r.headers['set-cookie']).toEqual([`ds${port}~sid=abc; Path=/; HttpOnly; SameSite=Lax`, `ds${port}~theme=dark; Path=/`]);
    expect(rewriteSetCookie('a=1; Domain=.example.com; Path=/; Secure; SameSite=None; Partitioned', 5281)).toBe('ds5281~a=1; Path=/; SameSite=Lax');
    expect(rewriteSetCookie('__Host-session=x; Path=/; Secure', 5281)).toBe('ds5281~__Host-session=x; Path=/');
    // The site gets only its own, under their own names: never another app's on localhost.
    expect(restoreCookieHeader('ds5281~sid=abc; ds5282~sid=other; plain=1; ds5281~__Host-session=x', 5281)).toBe('sid=abc; __Host-session=x');
  });

  it('sends requests as if they came from the site itself', async () => {
    const origin = new URL(frame).origin;
    const port = new URL(frame).port;
    const r = JSON.parse((await get('/echo', { origin, cookie: `ds${port}~sid=abc; ds1~sid=nope; other=1` })).body.toString()) as { host: string; origin: string; cookie: string };
    expect(r.host).toBe(new URL(upstreamUrl).host);
    expect(r.origin).toBe(upstreamUrl);
    expect(r.cookie).toBe('sid=abc');
  });

  it('follows redirects within the site, and lets one to another site leave', async () => {
    const origin = new URL(frame).origin;
    expect((await get('/login')).headers.location).toBe(`${origin}/account?x=1`);
    expect((await get('/sso')).headers.location).toBe('https://accounts.example.org/auth');
    expect(rewriteLocation('/next', new URL(upstreamUrl), origin)).toBe(`${origin}/next`);
  });

  it('decodes brotli and other character sets, rewrites the site’s address in styles, and leaves other files alone', async () => {
    const page = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' };
    expect((await get('/br', page)).body.toString()).toMatch(/<head><script>.*saywright\.js"><\/script><\/head><body>brotli/);
    const latin = await get('/latin', page);
    expect(latin.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(latin.body.toString('utf8')).toContain('<p>سلام</p>');
    expect((await get('/app.css')).body.toString()).toBe(`@font-face{src:url(${new URL(frame).origin}/f.woff2)}`);
    const blob = await get('/blob');
    expect(blob.headers['content-encoding']).toBe('gzip');
    expect([...zlib.gunzipSync(blob.body)]).toEqual([1, 2, 3, 4]);
  });

  it('leaves HTML a script fetched as the site sent it, and keeps service workers out', async () => {
    const partial = await get('/br', { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' });
    expect(partial.headers['content-encoding']).toBe('br');
    expect(zlib.brotliDecompressSync(partial.body).toString()).toBe('<html><head></head><body>brotli</body></html>');
    expect((await get('/sw.js', { 'service-worker': 'script' })).status).toBe(404);
  });

  it('answers only on localhost (another name pointing here is someone else’s page)', async () => {
    const u = new URL(frame);
    const r = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: u.port, path: '/', headers: { host: `evil.example:${u.port}` } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(r).toBe(421);
  });

  it('fetches only pages of the site it shows, never another host a request names (SSRF)', async () => {
    const u = new URL(frame);
    const status = (target: string) =>
      new Promise<number>((resolve) => {
        // The request line as an attacker would send it, untouched by URL normalisation.
        const socket = net.connect(Number(u.port), '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost:${u.port}\r\nConnection: close\r\n\r\n`));
        let head = '';
        socket.on('data', (d) => (head += d.toString()));
        socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0)));
      });
    const internal = new URL(upstreamUrl);
    for (const target of [`//127.0.0.1:${internal.port}/latest/meta-data`, `http://169.254.169.254/latest/meta-data`, `/\\169.254.169.254/x`]) expect(await status(target)).toBe(400);
    expect(await status('/')).toBe(200);
    const site = new URL('https://shop.example/app/');
    expect(targetOf('/cart?x=1', site)?.href).toBe('https://shop.example/cart?x=1');
    for (const raw of ['//evil.example/', 'https://evil.example/', '/\\evil.example/', 'evil.example']) expect(targetOf(raw, site)).toBeNull();
  });

  it('tunnels WebSockets (live reload) with the site’s host and origin', async () => {
    const u = new URL(frame);
    const socket = net.connect(Number(u.port), '127.0.0.1');
    const got = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n') && !buf.includes('ping')) socket.write('ping');
        if (buf.includes('ping')) resolve(buf);
      });
      socket.write(`GET /socket HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${u.origin}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.destroy();
    expect(got).toMatch(/^HTTP\/1\.1 101/);
    expect(got).toContain(`X-Seen-Host: ${new URL(upstreamUrl).host}`);
    expect(got).toContain(`X-Seen-Origin: ${upstreamUrl}`);
  });

  it('adds the bridge even to a page without a head', () => {
    const out = transformHtml('<p>bare</p>', { upstream: new URL('https://a.example'), proxyOrigin: 'http://localhost:5281', studio: 'http://localhost:5173', port: 5281 });
    expect(out).toMatch(/^<script>window\.__SAYWRIGHT_PROXY__=.*<\/script><script src="http:\/\/localhost:5173\/saywright\.js"><\/script><p>bare<\/p>$/);
  });
});

/** An upstream on a free port that answers `/echo` with the host it was asked for. */
async function echoSite(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: () => server.close() };
}

/** A raw request to the proxy, as the browser in the studio makes it (method, headers, a body). */
function send(method: string, route: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(frame);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: route, method, headers: { host: u.host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A WebSocket handshake through the proxy: what came back before the socket closed. */
function handshake(route: string, origin: string): Promise<string> {
  const u = new URL(frame);
  return new Promise((resolve) => {
    const socket = net.connect(Number(u.port), '127.0.0.1');
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(buf);
      }
    });
    socket.on('close', () => resolve(buf));
    socket.write(`GET ${route} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${origin}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

describe('the app’s API on another port of this computer', () => {
  let api: http.Server;
  let apiPort = 0;
  const seen: { method?: string; url?: string; host?: string; origin: string | null; cookie: string | null }[] = [];

  beforeAll(async () => {
    // An API that allows only the site's own address, with its cookies, as development APIs do.
    api = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null });
      const cors: Record<string, string> = req.headers.origin === upstreamUrl ? { 'Access-Control-Allow-Origin': upstreamUrl, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : {};
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type' });
        return res.end();
      }
      if (req.url === '/v1/auth/login') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Set-Cookie': ['refresh=r1; Path=/v1/auth; HttpOnly; Secure; SameSite=None', 'session=s1; Path=/'], 'Clear-Site-Data': '"cookies"' });
        return res.end('{"ok":true}');
      }
      if (req.url === '/v1/old') {
        res.writeHead(302, { ...cors, Location: '/v1/new' });
        return res.end();
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
    api.on('upgrade', (req, socket) => {
      const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Seen-Host: ${req.headers.host}\r\nX-Seen-Origin: ${req.headers.origin}\r\nX-Seen-Path: ${req.url}\r\n\r\n`);
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    apiPort = (api.address() as net.AddressInfo).port;
  });
  afterAll(() => api.close());

  const route = (rest: string, port = apiPort) => `/__saywright/http/127.0.0.1:${port}${rest}`;
  /** A request the page sent with its credentials (fetch's credentials: 'include'). */
  const withCredentials = (rest: string, port = apiPort) => `/__saywright/http+cred/127.0.0.1:${port}${rest}`;
  /** A script's fetch or XHR, as the browser sends it. */
  const fromThePage = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

  it('passes the page’s requests on from the site’s own address, with the site’s cookies when it sent its credentials', async () => {
    const proxyOrigin = new URL(frame).origin;
    const port = new URL(frame).port;
    const r = await send('POST', withCredentials('/v1/auth/login'), { ...fromThePage, origin: proxyOrigin, cookie: `ds${port}~session=s0; ds1~x=nope`, 'content-type': 'application/json' }, '{"email":"a@b.c"}');
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
    // Where the API is concerned, the site itself asked: its CORS rules apply as they do outside the studio (a JSON
    // body is asked about first).
    expect(seen.at(-2)).toMatchObject({ method: 'OPTIONS', url: '/v1/auth/login', origin: upstreamUrl, cookie: null });
    expect(seen.at(-1)).toEqual({ method: 'POST', url: '/v1/auth/login', host: `127.0.0.1:${apiPort}`, origin: upstreamUrl, cookie: 'session=s0' });
    // Its cookies join the site's: one for a path of the API stays under it, one for / is the whole site's.
    expect(r.headers['set-cookie']).toEqual([`ds${port}~refresh=r1; Path=${route('/v1/auth')}; HttpOnly; SameSite=Lax`, `ds${port}~session=s1; Path=/`]);
    // Nothing from the API can clear the studio's data.
    expect(r.headers['clear-site-data']).toBeUndefined();
    // A page's GET without its credentials: from the site's address, the query kept, and no cookies.
    expect(JSON.parse((await send('GET', route('/v1/me?x=1'), { ...fromThePage, cookie: `ds${port}~session=s0` })).body)).toEqual({ path: '/v1/me?x=1' });
    expect(seen.at(-1)).toMatchObject({ origin: upstreamUrl, cookie: null });
  });

  it('gives the page nothing from a service of this computer that doesn’t allow the site (CORS), as in its own tab', async () => {
    const asked: string[] = [];
    // An internal service with no CORS headers: other sites on this computer can't read it.
    const internal = http.createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"secret":"internal-admin-token"}');
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
    const port = (internal.address() as net.AddressInfo).port;
    try {
      const read = await send('GET', route('/admin', port), fromThePage);
      expect(read.status).toBe(403);
      expect(read.headers['x-saywright-blocked']).toBe('cors');
      expect(read.body).not.toContain('internal-admin-token');
      // A request the browser would ask about first is never sent when the service doesn't allow it.
      const post = await send('POST', withCredentials('/admin/users', port), { ...fromThePage, 'content-type': 'application/json' }, '{"role":"admin"}');
      expect(post.status).toBe(403);
      expect(asked).toEqual(['GET /admin', 'OPTIONS /admin/users']);
    } finally {
      internal.close();
    }
  });

  it('never answers a request whose answer the browser would keep from the page: no-cors, a navigation, a script, an image, a style', async () => {
    const asked: string[] = [];
    // A private service of this computer with no CORS headers.
    const internal = http.createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('window.leaked = "TOP-SECRET"');
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
    const port = (internal.address() as net.AddressInfo).port;
    try {
      const kinds: Record<string, string>[] = [
        { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' },
        { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' },
        { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
        { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'style' },
        { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' },
        { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
        { 'sec-fetch-site': 'same-origin' },
      ];
      for (const headers of kinds) {
        for (const path of [route('/secret.js', port), withCredentials('/secret.js', port)]) {
          const r = await send('GET', path, headers);
          expect(r.status, JSON.stringify(headers)).toBe(403);
          expect(r.body).toBe('');
        }
      }
      expect(asked).toEqual([]);
      expect(readableRequest(fromThePage)).toBe(true);
    } finally {
      internal.close();
    }
  });

  it('keeps the API’s redirects to itself on its path in the proxy', async () => {
    const r = await send('GET', route('/v1/old'), fromThePage);
    expect(r.headers.location).toBe(`${new URL(frame).origin}${route('/v1/new')}`);
  });

  it('refuses anyone but the page it shows, and any port or name but this computer’s other ones', async () => {
    const before = seen.length;
    const proxyOrigin = new URL(frame).origin;
    // Another site, the studio's own page, a request that says nothing, and a forged origin.
    const strangers: Record<string, string>[] = [{}, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { ...fromThePage, origin: 'https://evil.example' }, { origin: 'https://evil.example' }];
    for (const headers of strangers) expect((await send('POST', route('/v1/auth/login'), headers)).status).toBe(403);
    // The proxy's own port, the studio's, and a name that isn't this computer's.
    expect((await send('GET', route('/', Number(new URL(frame).port)), fromThePage)).status).toBe(403);
    expect((await send('GET', route('/', 5173), fromThePage)).status).toBe(403);
    expect((await send('GET', '/__saywright/http/169.254.169.254:80/latest/meta-data', fromThePage)).status).toBe(403);
    expect(seen.length).toBe(before);
    // The same rules, one by one.
    const local = new URL(upstreamUrl);
    expect(viaUrl(`/__saywright/https/localhost:5011/v1/x?y=1`, local, new Set())?.href).toBe('https://localhost:5011/v1/x?y=1');
    expect(viaUrl('/__saywright/http/localhost:5011/v1', new URL('https://shop.example'), new Set())).toBeNull();
    expect(viaUrl('/__saywright/http/localhost:5011//evil.example/', local, new Set())).toBeNull();
    expect(viaUrl('/__saywright/http/localhost:99999/', local, new Set())).toBeNull();
    expect(viaUrl('/__saywright/http/localhost:7357/api/status', local, new Set([7357]))).toBeNull();
    expect(fromPage({ 'sec-fetch-site': 'same-origin' }, proxyOrigin)).toBe(true);
    expect(fromPage({ origin: proxyOrigin }, proxyOrigin)).toBe(true);
    expect(fromPage({}, proxyOrigin)).toBe(false);
  });

  it('applies the API’s CORS rules as the browser does: who may read, with cookies or not, and what must be asked first', () => {
    const app = 'http://localhost:5173';
    // The page says whether it sent its credentials: fetch's credentials: 'include', an event stream's withCredentials.
    expect(viaRequest('/__saywright/http+cred/localhost:5011/v1/me', new URL(app), new Set())).toMatchObject({ credentials: true });
    expect(viaRequest('/__saywright/http/localhost:5011/v1/me', new URL(app), new Set())).toMatchObject({ credentials: false });
    // Reading the answer: the API names the site (with cookies, it says so too), or anyone, without cookies.
    expect(corsAllows({ 'access-control-allow-origin': app }, app, false)).toBe(true);
    expect(corsAllows({ 'access-control-allow-origin': app, 'access-control-allow-credentials': 'true' }, app, true)).toBe(true);
    expect(corsAllows({ 'access-control-allow-origin': app }, app, true)).toBe(false);
    expect(corsAllows({ 'access-control-allow-origin': '*' }, app, false)).toBe(true);
    expect(corsAllows({ 'access-control-allow-origin': '*' }, app, true)).toBe(false);
    // An internal service that says nothing of CORS: the page reads nothing from it, as in its own tab.
    expect(corsAllows({}, app, false)).toBe(false);
    expect(corsAllows({ 'access-control-allow-origin': 'http://localhost:9999' }, app, false)).toBe(false);
    // Simple requests go as they are; a JSON body, a header of the page's own or another method is asked first.
    expect(preflightFor('GET', { accept: 'application/json', 'sec-fetch-mode': 'cors', cookie: 'a=1', 'user-agent': 'x' })).toBeNull();
    expect(preflightFor('POST', { 'content-type': 'text/plain;charset=UTF-8' })).toBeNull();
    expect(preflightFor('POST', { 'content-type': 'application/json' })).toEqual({ method: 'POST', headers: ['content-type'] });
    expect(preflightFor('GET', { authorization: 'Bearer x', 'x-requested-with': 'XMLHttpRequest' })).toEqual({ method: 'GET', headers: ['authorization', 'x-requested-with'] });
    expect(preflightFor('DELETE', {})).toEqual({ method: 'DELETE', headers: [] });
    const ok = { 'access-control-allow-origin': app, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'content-type, authorization' };
    expect(preflightAllows(204, ok, { method: 'DELETE', headers: ['authorization'] }, app, true)).toBe(true);
    expect(preflightAllows(204, ok, { method: 'PUT', headers: [] }, app, true)).toBe(false);
    expect(preflightAllows(204, ok, { method: 'POST', headers: ['x-tenant'] }, app, true)).toBe(false);
    expect(preflightAllows(403, ok, { method: 'POST', headers: ['content-type'] }, app, true)).toBe(false);
    // A wildcard allows any header but authorization, and only without cookies.
    const any = { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' };
    expect(preflightAllows(200, any, { method: 'PATCH', headers: ['x-tenant'] }, app, false)).toBe(true);
    expect(preflightAllows(200, any, { method: 'GET', headers: ['authorization'] }, app, false)).toBe(false);
  });

  it('fails the way the browser would when nothing answers on that port', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    await expect(send('GET', route('/v1/me', closed), fromThePage)).rejects.toThrow();
  });

  it('tunnels the page’s WebSockets to the API, and no one else’s', async () => {
    const origin = new URL(frame).origin;
    const ok = await handshake(route('/hub?id=1'), origin);
    expect(ok).toMatch(/^HTTP\/1\.1 101/);
    expect(ok).toContain(`X-Seen-Host: 127.0.0.1:${apiPort}`);
    expect(ok).toContain(`X-Seen-Origin: ${upstreamUrl}`);
    expect(ok).toContain('X-Seen-Path: /hub?id=1');
    expect(await handshake(route('/hub'), 'https://evil.example')).toBe('');
    // A path for a port it won't pass on to is refused, never handed to the site itself.
    expect(await handshake(route('/hub', 5173), origin)).toBe('');
  });
});

describe('an app on this computer served over https with its own development certificate', () => {
  const tlsDir = path.join(__dirname, '../fixtures/tls');
  let site: https.Server;
  let siteUrl = '';
  const tlsProxy = new AppProxy({ studio: () => 'http://localhost:5173', port: 5560 });

  beforeAll(async () => {
    site = https.createServer({ key: fs.readFileSync(path.join(tlsDir, 'localhost-key.pem')), cert: fs.readFileSync(path.join(tlsDir, 'localhost-cert.pem')) }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Secure</title></head><body>over https</body></html>');
    });
    site.on('upgrade', (req, socket) => {
      const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on('data', (d) => socket.write(d));
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    siteUrl = `https://localhost:${(site.address() as net.AddressInfo).port}`;
  });
  afterAll(() => {
    tlsProxy.close();
    site.close();
  });

  it('shows its pages and tunnels its live-reload socket', async () => {
    const at = new URL(await tlsProxy.open(`${siteUrl}/`, 'secure/local'));
    const page = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: at.port, path: '/', headers: { host: at.host, 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('over https');
    expect(page.body).toContain('saywright.js');
    const socket = net.connect(Number(at.port), '127.0.0.1');
    const got = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n') && !buf.includes('ping')) socket.write('ping');
        if (buf.includes('ping')) resolve(buf);
      });
      socket.on('close', () => resolve(buf));
      socket.write(`GET /hmr HTTP/1.1\r\nHost: ${at.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${at.origin}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.destroy();
    expect(got).toMatch(/^HTTP\/1\.1 101/);
  });

  it('is accepted by its link check, and a certificate is never accepted from a host elsewhere', async () => {
    expect((await probeUrl(`${siteUrl}/`)).title).toBe('Secure');
    expect(tlsFor(new URL('https://shop.example/'))).toEqual({});
    expect(tlsFor(new URL('https://192.168.1.20/'))).toEqual({});
    expect(tlsFor(new URL('https://localhost:8443/'))).toEqual({ rejectUnauthorized: false });
  });

  it('says a certificate is why a site elsewhere can’t be shown', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
    expect(certificateProblem(err)).toBe('self-signed certificate');
    expect(certificateProblem(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))).toBeNull();
  });
});

describe('an app that is slow to answer, or streams', () => {
  let slow: http.Server;
  let slowUrl = '';
  // A short limit stands for the five minutes a request waits for the app to start answering.
  const patient = new AppProxy({ studio: () => 'http://localhost:5173', port: 5570, answerMs: 2000 });
  beforeAll(async () => {
    slow = http.createServer((req, res) => {
      if (req.url === '/never') return; // takes the request, never answers
      if (req.url === '/slow') return void setTimeout(() => res.end('done'), 1000);
      // An event stream: one event, then nothing for longer than the limit, then another.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 3000);
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    slowUrl = `http://127.0.0.1:${(slow.address() as net.AddressInfo).port}`;
  });
  afterAll(() => {
    patient.close();
    slow.closeAllConnections();
    slow.close();
  });
  const fetchVia = async (route: string, headers: Record<string, string> = {}) => {
    const at = new URL(await patient.open(`${slowUrl}/`, 'slow/local'));
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: at.port, path: route, headers: { host: at.host, ...headers } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          res.on('error', reject);
        })
        .on('error', reject);
    });
  };

  it('waits for a slow answer, and never cuts a stream that is quiet for longer than the wait for an answer', async () => {
    expect(await fetchVia('/slow')).toEqual({ status: 200, body: 'done' });
    const stream = await fetchVia('/events');
    expect(stream.status).toBe(200);
    expect(stream.body).toBe('data: first\n\ndata: second\n\n');
  });

  it('shows its error page when the app never starts answering', async () => {
    const r = await fetchVia('/never', { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' });
    expect(r.status).toBe(502);
    expect(r.body).toContain('didn’t answer');
    expect(r.body).toContain('It didn’t start answering within 2 seconds.');
  });
});

describe('an app’s proxy', () => {
  it('stays on the same port when the app moves to another one, so its cookies and storage stay', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-')), 'ports.json');
    const apps = new AppProxy({ studio: () => 'http://localhost:5173', port: 5520, stateFile: file });
    const [before, after] = [await echoSite(), await echoSite()];
    try {
      const frame = await apps.open(`${before.url}/`, 'shop-1a2b/local');
      expect(await apps.open(`${after.url}/cart`, 'shop-1a2b/local')).toBe(`${new URL(frame).origin}/cart`);
      // Requests now go to where the app runs now.
      const r = await fetch(`${new URL(frame).origin}/echo`).then((res) => res.json());
      expect(r).toEqual({ host: new URL(after.url).host });
      expect(apps.upstreamFor(`${new URL(frame).origin}/cart`)).toBe(`${after.url}/cart`);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'shop-1a2b/local': Number(new URL(frame).port) });
    } finally {
      apps.close();
      before.close();
      after.close();
    }
  });

  it('takes over the port an earlier version kept for the app’s address, and writes the file whole', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-'));
    const file = path.join(dir, 'ports.json');
    const site = await echoSite();
    // A port nothing else holds: the system picks it.
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    fs.writeFileSync(file, JSON.stringify({ [site.url]: port, 'http://localhost:9999': 5555 }));
    const apps = new AppProxy({ studio: () => 'http://localhost:5173', port: 5590, stateFile: file });
    try {
      expect(await apps.open(`${site.url}/`, 'notes-9f8e/local')).toBe(`http://localhost:${port}/`);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'notes-9f8e/local': port, 'http://localhost:9999': 5555 });
      expect(fs.readdirSync(dir)).toEqual(['ports.json']);
    } finally {
      apps.close();
      site.close();
    }
  });

  it('lets go of an app’s port when the app is removed', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-')), 'ports.json');
    // A port the system picks: one from a fixed range could be taken again at once by a test running beside this one.
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const apps = new AppProxy({ studio: () => 'http://localhost:5173', port: free, stateFile: file });
    const site = await echoSite();
    try {
      const frame = await apps.open(`${site.url}/`, 'gone-0000/local');
      apps.release('gone-0000');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
      await expect(fetch(`${new URL(frame).origin}/echo`)).rejects.toThrow();
    } finally {
      apps.close();
      site.close();
    }
  });
});

describe('a page that streams', () => {
  /** A page sent in two parts, `pause` ms apart (streamed server rendering), gzipped when `gzip`. */
  async function streaming(gzip: boolean, pause = 1500) {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
      const out = gzip ? zlib.createGzip() : res;
      if (gzip) out.pipe(res);
      out.write('<!doctype html><html><head><title>Orders</title></head><body><h1>Orders</h1>');
      if (gzip) (out as zlib.Gzip).flush();
      setTimeout(() => out.end('<ul><li>Slow part</li></ul></body></html>'), pause);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: () => server.close() };
  }

  it.each([false, true])('shows its first part, with the bridge, before the rest arrives (gzip: %s)', async (gzip) => {
    const site = await streaming(gzip);
    const apps = new AppProxy({ studio: () => 'http://localhost:5173', port: 5650 });
    try {
      const frame = await apps.open(`${site.url}/`);
      const started = Date.now();
      const parts: Array<{ at: number; text: string }> = [];
      await new Promise<void>((resolve, reject) => {
        const u = new URL(frame);
        http
          .get({ host: '127.0.0.1', port: u.port, path: '/', agent: false, headers: { host: u.host, 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' } }, (res) => {
            expect(res.headers['content-encoding']).toBeUndefined();
            res.on('data', (d: Buffer) => parts.push({ at: Date.now() - started, text: d.toString() }));
            res.on('end', resolve);
          })
          .on('error', reject);
      });
      expect(parts[0].at).toBeLessThan(1000);
      expect(parts[0].text).toMatch(/<head><script>window\.__SAYWRIGHT_PROXY__=.*saywright\.js"><\/script><title>Orders<\/title>/);
      expect(parts.map((p) => p.text).join('')).toMatch(/<h1>Orders<\/h1><ul><li>Slow part<\/li><\/ul><\/body><\/html>$/);
      expect(parts.at(-1)!.at).toBeGreaterThanOrEqual(1400);
    } finally {
      apps.close();
      site.close();
    }
  });

  it('rewrites the site’s address wherever a chunk ends', () => {
    const ctx = { upstream: new URL('http://127.0.0.1:4000'), proxyOrigin: 'http://localhost:5281', studio: 'http://localhost:5173', port: 5281 };
    const page = '<html><head><link rel="stylesheet" href="http://127.0.0.1:4000/app.css"></head><body><img src="http://127.0.0.1:4000/logo.png"><a href="http://127.0.0.1:4000/about">About</a></body></html>';
    const whole = transformHtml(page, ctx);
    for (let size = 1; size < 40; size += 3) {
      const rewriter = new PageRewriter(ctx);
      let out = '';
      for (let i = 0; i < page.length; i += size) out += rewriter.push(page.slice(i, i + size));
      expect(out + rewriter.end()).toBe(whole);
    }
    const css = 'a{background:url(http://127.0.0.1:4000/a.png)}b{background:url(http://127.0.0.1:4000/b.png)}';
    for (let size = 1; size < 30; size += 4) {
      const text = new TextReplacer('http://127.0.0.1:4000', 'http://localhost:5281');
      let out = '';
      for (let i = 0; i < css.length; i += size) out += text.push(css.slice(i, i + size));
      expect(out + text.end()).toBe(css.split('http://127.0.0.1:4000').join('http://localhost:5281'));
    }
  });

  it('puts the bridge after the doctype of a page without a head, so it stays in standards mode', () => {
    const out = transformHtml('<!doctype html><title>Bare</title><p>bare</p>', { upstream: new URL('https://a.example'), proxyOrigin: 'http://localhost:5281', studio: 'http://localhost:5173', port: 5281 });
    expect(out).toMatch(/^<!doctype html><script>window\.__SAYWRIGHT_PROXY__=.*saywright\.js"><\/script><title>Bare<\/title><p>bare<\/p>$/);
  });
});

describe('a browser that gives up on a request', () => {
  it('cancels the request to the site, and the studio carries on (it used to crash when the site answered after)', async () => {
    let arrived = () => {};
    let aborted = 0;
    // A site that answers a moment later, as a slow page does.
    const site = http.createServer((req, res) => {
      arrived();
      req.on('close', () => {
        if (!res.headersSent) aborted++;
      });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head></head><body>slow page</body></html>');
      }, 100);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const apps = new AppProxy({ studio: () => 'http://localhost:5173', port: 5590, stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-')), 'ports.json') });
    try {
      const url = await apps.open(`http://127.0.0.1:${(site.address() as net.AddressInfo).port}/`);
      for (let i = 0; i < 10; i++) {
        const hit = new Promise<void>((r) => (arrived = r));
        // A page (HTML, rewritten as it streams) and a plain file: both ways of passing an answer on.
        const req = http.get(i % 2 ? `${url}app.js` : url, { headers: { Accept: i % 2 ? '*/*' : 'text/html' } }, (r) => r.resume());
        req.on('error', () => undefined);
        await hit;
        req.destroy();
        await new Promise((r) => setTimeout(r, 160));
      }
      // The site's requests were let go, and the proxy still answers.
      expect(aborted).toBe(10);
      const page = await fetch(url, { headers: { Accept: 'text/html' } });
      expect(await page.text()).toContain('slow page');
    } finally {
      apps.close();
      site.close();
    }
  });

  it('a file that goes before it is sent ends that answer only', async () => {
    const { sendFile } = await import('../../server/streams');
    const server = http.createServer((_req, res) => sendFile(path.join(os.tmpdir(), 'saywright-no-such-file.wasm'), res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const failed = await fetch(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`).then(
        () => false,
        () => true,
      );
      expect(failed).toBe(true);
      // Still serving.
      expect(server.listening).toBe(true);
    } finally {
      server.close();
    }
  });
});
