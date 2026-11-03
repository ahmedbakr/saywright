/**
 * The bridge in an app answers the studio only: another page on this computer
 * that puts the app in a frame gets nothing back. And when the app's plugin and
 * the studio are versions that can't work together, the studio says which one
 * to update instead of waiting for the app forever.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { resetAll, SHOP_URL, store } from './helpers';

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
  ['studio', { v: 99, oldest: 50 }, /This studio is older than the app’s Saywright plugin[\s\S]*npx saywright@latest/],
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
