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
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppProxy, fromPage, PageRewriter, restoreCookieHeader, rewriteLocation, rewriteSetCookie, TextReplacer, transformHtml, upstreamUrl as targetOf, viaUrl } from '../../server/apps/proxy';

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
    // An API that allows only the site's own address, as development APIs do.
    api = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null });
      if (req.url === '/v1/auth/login') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['refresh=r1; Path=/v1/auth; HttpOnly; Secure; SameSite=None', 'session=s1; Path=/'], 'Clear-Site-Data': '"cookies"' });
        return res.end('{"ok":true}');
      }
      if (req.url === '/v1/old') {
        res.writeHead(302, { Location: '/v1/new' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
  const fromThePage = { 'sec-fetch-site': 'same-origin' };

  it('passes the page’s requests on from the site’s own address, with the site’s cookies', async () => {
    const proxyOrigin = new URL(frame).origin;
    const port = new URL(frame).port;
    const r = await send('POST', route('/v1/auth/login'), { ...fromThePage, origin: proxyOrigin, cookie: `ds${port}~session=s0; ds1~x=nope`, 'content-type': 'application/json' }, '{"email":"a@b.c"}');
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
    // Where the API is concerned, the site itself asked: its CORS rules apply as they do outside the studio.
    expect(seen.at(-1)).toEqual({ method: 'POST', url: '/v1/auth/login', host: `127.0.0.1:${apiPort}`, origin: upstreamUrl, cookie: 'session=s0' });
    // Its cookies join the site's: one for a path of the API stays under it, one for / is the whole site's.
    expect(r.headers['set-cookie']).toEqual([`ds${port}~refresh=r1; Path=${route('/v1/auth')}; HttpOnly; SameSite=Lax`, `ds${port}~session=s1; Path=/`]);
    // Nothing from the API can clear the studio's data.
    expect(r.headers['clear-site-data']).toBeUndefined();
    // A page's own GET: no origin, the query kept.
    expect(JSON.parse((await send('GET', route('/v1/me?x=1'), fromThePage)).body)).toEqual({ path: '/v1/me?x=1' });
    expect(seen.at(-1)?.origin).toBeNull();
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
