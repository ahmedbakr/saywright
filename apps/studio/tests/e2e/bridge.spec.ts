/**
 * The bridge in an app answers the studio only: another page on this computer
 * that puts the app in a frame gets nothing back. And when the app's plugin and
 * the studio are versions that can't work together, the studio says which one
 * to update instead of waiting for the app forever.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { openStudio, resetAll, SHOP_URL, STUDIO, store } from './helpers';

test.beforeEach(() => resetAll());

test('a page that frames the app gets no answer from its bridge', async ({ page }) => {
  // Another site on this computer: it frames the app and keeps saying hello, as the studio does.
  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<iframe src="${SHOP_URL}/" style="width:800px;height:600px"></iframe>
<script>
  window.answers = [];
  addEventListener('message', (e) => { if (e.data && e.data.ns === 'saywright') window.answers.push(e.data.type); });
  const f = document.querySelector('iframe');
  setInterval(() => f.contentWindow.postMessage({ ns: 'saywright', type: 'hello', v: 1 }, '*'), 200);
</script>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  try {
    await page.goto(`http://localhost:${(site.address() as AddressInfo).port}/`);
    const app = page.frameLocator('iframe');
    await expect(app.locator('.shell')).toBeVisible();
    // The bridge is there, and hears the hellos, but says nothing back.
    await expect.poll(() => page.frames()[1].evaluate(() => (window as Window & { __saywrightBridge?: boolean }).__saywrightBridge)).toBe(true);
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => (window as Window & { answers?: string[] }).answers)).toEqual([]);
  } finally {
    site.close();
  }
});

for (const [side, ready, says] of [
  ['plugin', { v: 0 }, /This app’s Saywright plugin needs an update[\s\S]*npm i -D @saywright\/vite@latest/],
  ['studio', { v: 99, oldest: 50 }, /This studio is older than the app’s Saywright plugin[\s\S]*npx @saywright\/studio@latest/],
] as const) {
  test(`an app whose ${side === 'plugin' ? 'plugin is older' : 'plugin is newer'} than the studio can follow says what to update`, async ({ page }) => {
    // The app's bridge from another release: it answers hello with its version, and nothing else.
    await page.route('**/__saywright/bridge.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `addEventListener('message', (e) => { if (e.data && e.data.ns === 'saywright' && e.data.type === 'hello') e.source.postMessage({ ns: 'saywright', type: 'ready', ...${JSON.stringify(ready)}, url: location.href, title: document.title }, e.origin); });`,
      }),
    );
    await page.addInitScript(() => localStorage.setItem('saywright.settings', JSON.stringify({ state: { onboarded: true, theme: 'dark', voice: { engine: 'browser' } }, version: 1 })));
    await page.goto('/');
    await expect(page.locator(`[data-outdated="${side}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-stage]')).toContainText(says);
    expect(await store<boolean>(page, 's.app.connected')).toBe(false);
  });
}

/** A plain page whose own classic script declares names a bundle could use too, with the studio's script or not. */
const plainPage = (bridge: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>Cart</title>
${bridge ? `<script src="${STUDIO}/saywright.js"></script>` : ''}</head><body>
<button id="add">Add</button> <p id="cart">Cart: 0 items</p>
<script>
const now = Date.now(); let start = now; var step = 1; const find = (s) => document.querySelector(s);
function collapse() {} function describe() {}
let items = 0;
find('#add').onclick = () => { items += step; find('#cart').textContent = 'Cart: ' + items + ' items'; };
window.ran = true;
</script></body></html>`;

test('an app whose own script declares common names runs with the studio’s script, by tag and through the proxy', async ({ page, browser }) => {
  const errors: string[] = [];
  const site = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(plainPage(req.url !== '/bare'));
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://localhost:${(site.address() as AddressInfo).port}`;
  const call = async <T>(method: string, route: string, body?: unknown): Promise<T> =>
    (await fetch(`${STUDIO}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<T>;
  let linked = '';
  try {
    // By script tag, in its own tab: the page's script runs, and the bridge adds no global but its own.
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/bare`);
    const bare = await page.evaluate(() => Object.keys(window));
    await page.goto(`${origin}/`);
    expect(await page.evaluate(() => (window as Window & { ran?: boolean }).ran)).toBe(true);
    const added = (await page.evaluate(() => Object.keys(window))).filter((k) => !bare.includes(k));
    expect(added.filter((k) => !['__SAYWRIGHT__', '__saywrightBridge'].includes(k))).toEqual([]);
    await page.locator('#add').click();
    await expect(page.locator('#cart')).toHaveText('Cart: 1 items');
    expect(errors).toEqual([]);

    // Through the proxy, in the studio.
    const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { url: `${origin}/bare` });
    linked = (await call<{ app: { id: string } }>('POST', '/apps', { probe, url: `${origin}/bare` })).app.id;
    const studio = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    studio.on('pageerror', (e) => errors.push(e.message));
    await openStudio(studio);
    await studio.waitForFunction(() => (window as any).__saywrightStore.get().app.connected);
    const frame = studio.frames().find((f) => f.url().includes('/bare'))!;
    expect(await frame.evaluate(() => (window as Window & { ran?: boolean }).ran)).toBe(true);
    await studio.keyboard.press('u');
    await studio.frameLocator('iframe').locator('#add').click();
    await expect(studio.frameLocator('iframe').locator('#cart')).toHaveText('Cart: 1 items');
    expect(errors).toEqual([]);
    await studio.close();
  } finally {
    // The sample shop is the open app again, for the tests that follow.
    const { apps } = await call<{ apps: { id: string; root: string | null }[] }>('GET', '/apps');
    const shop = apps.find((a) => a.root?.endsWith('.e2e-shop'));
    if (shop) await call('POST', `/apps/${shop.id}/open`, { decide: 'undo' }).catch(() => undefined);
    if (linked) await call('DELETE', `/apps/${linked}`).catch(() => undefined);
    site.close();
  }
});
