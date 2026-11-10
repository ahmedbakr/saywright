/**
 * An app shown through the studio's proxy that calls its own API on another port of this computer, whose CORS rules
 * allow only the app's own address (as development APIs do): signing in with fetch and reading the user back with
 * XHR, as axios does, work in the studio as they do in the app's own tab, cookie included.
 */
import http from 'node:http';
import type net from 'node:net';
import { expect, test } from '@playwright/test';
import { openStudio, resetAll, STUDIO } from './helpers';

interface AppsState {
  apps: { id: string; root: string | null }[];
}

const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${STUDIO}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
};

const page = (api: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Approvals</title></head><body>
<h1>Approvals</h1>
<button data-testid="login">Log in</button> <button data-testid="me">Who am I</button>
<p data-testid="out">Not signed in</p>
<script>
const API = '${api}';
const out = document.querySelector('[data-testid="out"]');
document.querySelector('[data-testid="login"]').onclick = async () => {
  try {
    const r = await fetch(API + '/v1/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com' }) });
    out.textContent = 'Signed in: ' + (await r.json()).user;
  } catch (e) {
    out.textContent = 'Network Error';
  }
};
document.querySelector('[data-testid="me"]').onclick = () => {
  const x = new XMLHttpRequest();
  x.open('GET', API + '/v1/me');
  x.withCredentials = true;
  x.onload = () => (out.textContent = 'Me: ' + JSON.parse(x.responseText).user);
  x.onerror = () => (out.textContent = 'Network Error');
  x.send();
};
</script></body></html>`;

let app: http.Server;
let api: http.Server;
/** A private service of this computer that sends no CORS headers: no other page may read it. */
let secret: http.Server;
let secretPort = 0;
let appOrigin = '';
let linked = '';
/** What reached the API: method, path and the origin it came from. */
const seen: string[] = [];

const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

test.beforeAll(async () => {
  api = http.createServer((req, res) => {
    const ok = req.headers.origin === appOrigin;
    const cors: Record<string, string> = ok ? { 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(ok ? 204 : 403, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type' });
      return res.end();
    }
    seen.push(`${req.method} ${req.url} from ${req.headers.origin ?? 'the page itself'}`);
    if (req.url === '/v1/auth/login' && req.method === 'POST') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Set-Cookie': 'token=t1; Path=/; HttpOnly; SameSite=Lax' });
      return res.end('{"user":"admin"}');
    }
    if (req.url === '/v1/me') {
      const signed = /(^|;\s*)token=t1(;|$)/.test(req.headers.cookie ?? '');
      res.writeHead(signed ? 200 : 401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user: signed ? 'admin' : null }));
    }
    res.writeHead(404, cors);
    res.end();
  });
  const apiPort = await listen(api);
  secret = http.createServer((req, res) => {
    if (req.url === '/secret.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end('window.leaked = "TOP-SECRET-JS";');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"secret":"TOP-SECRET"}');
  });
  secretPort = await listen(secret);
  app = http.createServer((req, res) => {
    if (req.url === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>Echo</title><p data-testid="echo">${req.method} ${body}</p>`);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(`http://localhost:${apiPort}`));
  });
  appOrigin = `http://localhost:${await listen(app)}`;
});

test.afterAll(() => {
  app.close();
  api.close();
  secret.close();
});

test.beforeEach(() => resetAll());
test.afterEach(async () => {
  const { apps } = await call<AppsState>('GET', '/apps');
  const shop = apps.find((a) => a.root?.endsWith('.e2e-shop'));
  if (shop) await call('POST', `/apps/${shop.id}/open`, { decide: 'undo' }).catch(() => undefined);
  if (linked) await call('DELETE', `/apps/${linked}`).catch(() => undefined);
});

test('an app shown through the proxy reaches its own API on another port, from its own address', async ({ page: tab, browser }) => {
  // In its own tab, as the API's CORS rules expect.
  seen.length = 0;
  await tab.goto(appOrigin);
  await tab.getByTestId('login').click();
  await expect(tab.getByTestId('out')).toHaveText('Signed in: admin');
  await tab.getByTestId('me').click();
  await expect(tab.getByTestId('out')).toHaveText('Me: admin');
  const ownTab = [...seen];

  // In the studio: linked by its address, so it is shown through the proxy, at another address.
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { url: `${appOrigin}/` });
  linked = (await call<{ app: { id: string } }>('POST', '/apps', { probe, url: `${appOrigin}/` })).app.id;
  const studio = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openStudio(studio);
  await studio.waitForFunction(() => (window as any).__saywrightStore.get().app.connected);
  const frameUrl = await studio.evaluate(() => (window as any).__saywrightStore.get().status.target.frameUrl as string);
  expect(new URL(frameUrl).origin).not.toBe(appOrigin);
  await studio.keyboard.press('u');
  const shown = studio.frameLocator('iframe');
  seen.length = 0;
  await shown.getByTestId('login').click();
  await expect(shown.getByTestId('out')).toHaveText('Signed in: admin');
  // The cookie the API set comes back to it, through XHR as through fetch.
  await shown.getByTestId('me').click();
  await expect(shown.getByTestId('out')).toHaveText('Me: admin');
  // The API saw what it sees from the app's own tab: the app's own address, never the proxy's.
  expect(seen).toEqual(ownTab);
  expect(seen).toContain(`POST /v1/auth/login from ${appOrigin}`);
  await studio.close();
});

test('a page shown through the proxy can’t read another service of this computer that doesn’t allow it', async ({ browser }) => {
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { url: `${appOrigin}/` });
  linked = (await call<{ app: { id: string } }>('POST', '/apps', { probe, url: `${appOrigin}/` })).app.id;
  const studio = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openStudio(studio);
  await studio.waitForFunction(() => (window as any).__saywrightStore.get().app.connected);
  const frameUrl = await studio.evaluate(() => (window as any).__saywrightStore.get().status.target.frameUrl as string);
  const shown = studio.frames().find((f) => f.url().startsWith(new URL(frameUrl).origin));
  expect(shown).toBeTruthy();
  const tried = await shown!.evaluate(async (port) => {
    const text = (r: Promise<Response>) =>
      r.then(
        (res) => res.text(),
        (e: Error) => `failed: ${e.message}`,
      );
    const script = (src: string) =>
      new Promise<string>((resolve) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve(`loaded: ${String((window as any).leaked)}`);
        s.onerror = () => resolve('refused');
        document.head.append(s);
      });
    return {
      noCors: await text(fetch(`http://localhost:${port}/secret`, { mode: 'no-cors' })),
      // Sent by the browser itself, as outside the studio: an opaque answer.
      noCorsType: (await fetch(`http://localhost:${port}/secret`, { mode: 'no-cors' })).type,
      noCorsWithCookies: await text(fetch(`http://localhost:${port}/secret`, { mode: 'no-cors', credentials: 'include' })),
      cors: await text(fetch(`http://localhost:${port}/secret`)),
      proxyPath: await text(fetch(`/__saywright/http/localhost:${port}/secret`, { mode: 'no-cors' })),
      proxyPathWithCookies: await text(fetch(`/__saywright/http+cred/localhost:${port}/secret`, { mode: 'no-cors', credentials: 'include' })),
      proxyPathCors: await text(fetch(`/__saywright/http/localhost:${port}/secret`)),
      script: await script(`/__saywright/http/localhost:${port}/secret.js`),
    };
  }, secretPort);
  for (const [how, got] of Object.entries(tried)) expect(got, how).not.toContain('TOP-SECRET');
  expect(tried.noCors).toBe('');
  expect(tried.noCorsType).toBe('opaque');
  expect(tried.script).toBe('refused');
  // The app's own API, which allows the app's address, still answers it.
  await studio.keyboard.press('u');
  await studio.frameLocator('iframe').getByTestId('login').click();
  await expect(studio.frameLocator('iframe').getByTestId('out')).toHaveText('Signed in: admin');
  await studio.close();
});

test('a form the page’s script builds with the app’s full address posts its fields through the proxy', async ({ browser }) => {
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { url: `${appOrigin}/` });
  linked = (await call<{ app: { id: string } }>('POST', '/apps', { probe, url: `${appOrigin}/` })).app.id;
  const studio = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openStudio(studio);
  await studio.waitForFunction(() => (window as any).__saywrightStore.get().app.connected);
  const frameUrl = await studio.evaluate(() => (window as any).__saywrightStore.get().status.target.frameUrl as string);
  const shown = studio.frames().find((f) => f.url().startsWith(new URL(frameUrl).origin))!;
  // A button click (requestSubmit) and form.submit(), each with the app's own full address.
  for (const how of ['requestSubmit', 'submit'] as const) {
    await shown.evaluate(
      ([origin, how]) => {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = `${origin}/echo`;
        form.innerHTML = '<input name="email" value="a@b.c">';
        document.body.append(form);
        form[how]();
      },
      [appOrigin, how] as const,
    );
    await expect(studio.frameLocator('iframe').getByTestId('echo')).toHaveText('POST email=a%40b.c');
    expect(new URL(studio.frames().find((f) => f.url().includes('/echo'))!.url()).origin).toBe(new URL(frameUrl).origin);
    await shown.goto(frameUrl);
  }
  await studio.close();
});
