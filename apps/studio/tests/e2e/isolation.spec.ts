/**
 * The app in the studio's frame runs in a process of its own: the studio's work can't hold up the app (and be
 * reported as the app being slow), and the app's work, like an expert review of a big page, can't freeze the
 * studio. It is still the same site as the studio, so its cookies work in the frame as they do in its own tab.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { openStudio, resetAll, SHOP_URL } from './helpers';

// Playwright's trace takes its snapshots through the studio's page, which this test keeps busy on purpose.
test.use({ trace: 'off' });
test.beforeEach(() => resetAll());

/** Keep a page's thread busy for `ms`, starting now, without waiting for it. */
const busyFor = (where: Page | Frame, ms: number) =>
  where.evaluate((ms) => void setTimeout(() => {
    const t = performance.now();
    while (performance.now() - t < ms);
  }, 0), ms);

/** How long a page takes to answer at all. */
async function answerMs(where: Page | Frame): Promise<number> {
  const t = Date.now();
  await where.evaluate(() => 1);
  return Date.now() - t;
}

test('the app runs apart from the studio: either can be busy without holding up the other, and its cookies work as in its own tab', async ({ page, browser }) => {
  await openStudio(page);
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  expect(targetInfos.filter((t) => t.type === 'iframe' && t.url.startsWith(SHOP_URL))).toHaveLength(1);
  const app = page.frames().find((f) => f.url().startsWith(SHOP_URL))!;
  const field = page.frameLocator('iframe').getByTestId('coupon-input');
  await field.focus();

  // The studio busy for 4 s: the app answers, and what is typed in it shows, meanwhile.
  await busyFor(page, 4000);
  await page.waitForTimeout(100);
  await page.keyboard.type('SAVE20');
  expect(await answerMs(app)).toBeLessThan(1500);
  expect(await app.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe('SAVE20');
  expect(await answerMs(page)).toBeGreaterThan(2000);

  // The app busy for 4 s: the studio answers meanwhile.
  await busyFor(app, 4000);
  await page.waitForTimeout(100);
  expect(await answerMs(page)).toBeLessThan(1500);

  // A cookie the app sets in the frame is kept, sent with its requests, and the same one its own tab sees.
  await app.evaluate(() => (document.cookie = 'saywright-e2e=frame; path=/'));
  expect(await app.evaluate(() => document.cookie)).toContain('saywright-e2e=frame');
  const sent = page.waitForRequest((r) => r.url().startsWith(`${SHOP_URL}/?cookie-check`));
  await app.evaluate(() => fetch('/?cookie-check').then(() => undefined));
  expect(await (await sent).headerValue('cookie')).toContain('saywright-e2e=frame');
  const tab = await page.context().newPage();
  await tab.goto(`${SHOP_URL}/`);
  expect(await tab.evaluate(() => document.cookie)).toContain('saywright-e2e=frame');
});
