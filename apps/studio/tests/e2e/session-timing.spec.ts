/**
 * Waiting is never a problem: a tester reads, thinks and talks between actions.
 * The studio's own work (hand tracking, speech) must not be recorded as the app
 * being slow, and neither must what happened before the session started:
 * whether the app shares the studio's thread (browsers without site isolation)
 * or has a process of its own (Chromium), where a click in it can still wait
 * for the studio while the browser asks the studio's page where it landed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Frame, type Page } from '@playwright/test';
import { BROWSER, E2E_SHOP, openStudio, resetAll, SHOP_URL, STUDIO } from './helpers';

// Playwright's trace recording stops Chromium reporting how long input waited (Event Timing).
test.use({ trace: 'off' });
test.beforeEach(() => resetAll());

/** Keep this page's thread busy for a while (as a task of its own, like real work), and wait until it is done. */
function busy(where: Page | Frame, ms: number): Promise<void> {
  return where.evaluate((ms) => new Promise<void>((done) => setTimeout(() => {
    const t = performance.now();
    while (performance.now() - t < ms);
    done();
  }, 0)), ms);
}

/** Start the same work without waiting for it, so input can arrive while it runs. */
async function busyFor(where: Page | Frame, ms: number): Promise<void> {
  await where.evaluate((ms) => void setTimeout(() => {
    const t = performance.now();
    while (performance.now() - t < ms);
  }, 0), ms);
  await new Promise((r) => setTimeout(r, 100));
}

for (const shared of [false, true]) {
  test.describe(shared ? 'the app on the studio’s thread' : 'the app in a process of its own', () => {
    let other: Browser | null = null;
    test.afterEach(() => other?.close());

    test('waiting is never a problem: the studio’s own work, and the page’s before the session, stay out of it', async ({ page: tab, playwright, baseURL, viewport }) => {
      test.setTimeout(120_000);
      let page = tab;
      if (shared) {
        // Site isolation off: one process for the studio and the app, as in browsers without it.
        other = await playwright.chromium.launch({ ...BROWSER, args: ['--disable-site-isolation-trials'] });
        page = await (await other.newContext({ baseURL, viewport })).newPage();
      }
      // Only what happens in the app matters here.
      await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
      await openStudio(page);
      const app = page.frameLocator('iframe');
      await expect(app.getByTestId('coupon-apply')).toBeVisible();
      const frame = page.frames().find((f) => f.url().startsWith(SHOP_URL))!;
      const { targetInfos } = await (await page.context().browser()!.newBrowserCDPSession()).send('Target.getTargets');
      expect(targetInfos.some((t) => t.type === 'iframe' && t.url.startsWith(SHOP_URL))).toBe(!shared);
      // The app was busy before the session started.
      await busy(frame, 900);

      await page.getByRole('button', { name: 'Record session', exact: true }).click();
      await page.getByRole('button', { name: 'Start recording' }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();

      // The studio around the app works (hand tracking, speech).
      await busy(page, 1200);
      // A click that has to wait for the studio's work: not the app's slowness.
      const box = (await app.getByTestId('coupon-apply').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await busyFor(page, 1500);
      await page.mouse.down();
      await page.mouse.up();
      // A click that waits for the app's own work: the app is slow.
      await busyFor(frame, 600);
      await page.mouse.down();
      await page.mouse.up();
      // And the tester just waits.
      await page.waitForTimeout(4000);
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.getByRole('button', { name: 'Report ready' }).click({ timeout: 90_000 });

      const id = new URL(page.url()).pathname.split('/').pop()!;
      const events = fs.readFileSync(path.join(E2E_SHOP, '.saywright/sessions', id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; metric?: string; value?: number });
      const perf = (metric: string) => events.filter((e) => e.type === 'perf' && e.metric === metric).map((e) => e.value!);
      // The app's own long task is recorded; the studio's (1.2 and 1.5 s) and the one from before the session (0.9 s) are not.
      expect(perf('longtask').some((v) => v >= 450)).toBe(true);
      expect(perf('longtask').every((v) => v < 850)).toBe(true);
      // One slow response: the click that waited on the app, not the one that waited on the studio.
      expect(perf('inp').filter((v) => v >= 1000)).toEqual([]);
      expect(perf('inp').filter((v) => v >= 250)).toHaveLength(1);

      const d = (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as { analysis: { issues: { kind: string; title: string }[] } };
      expect(d.analysis.issues.filter((g) => g.kind === 'performance').map((g) => g.title)).toEqual([expect.stringMatching(/^Slow to respond/)]);
      expect(d.analysis.issues.some((g) => /froze|frozen|busy|pause/i.test(g.title))).toBe(false);
    });
  });
}
