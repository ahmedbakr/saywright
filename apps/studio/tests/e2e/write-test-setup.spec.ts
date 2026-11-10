/**
 * A first test in an app that doesn't have Playwright yet: the run says so at once, and one click on its card adds
 * it and runs the test. (The sample has Playwright, so the studio's two answers are stood in for here; the unit tests
 * cover what the server does: when it says so, and how it adds it.)
 */
import { expect, test, type Page } from '@playwright/test';
import { appPoint, expectIsland, openStudio, resetAll, store } from './helpers';

test.beforeEach(() => resetAll());

async function check(page: Page, testId: string, words: string): Promise<void> {
  const at = await appPoint(page, testId, 0.5);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill(words);
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
}

test('an app without Playwright is offered it on the run’s card: one click adds it, and the test runs', async ({ page }) => {
  test.setTimeout(150_000);
  let runs = 0;
  let added = 0;
  await page.route('**/api/tests/run', (route) =>
    runs++ === 0
      ? route.fulfill({ json: { status: 'setup-needed', durationMs: 0, needs: 'playwright', message: 'This app doesn’t have Playwright yet (@playwright/test), which runs the test. Add it here, or run in the app’s folder: npm install --save-dev @playwright/test.' } })
      : route.continue(),
  );
  await page.route('**/api/tests/playwright', (route) => {
    added++;
    return route.fulfill({ json: { ok: true } });
  });

  await openStudio(page);
  await page.keyboard.press('r');
  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBe(2);
  await check(page, 'summary-total', 'this should show $80.80');
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  await page.getByRole('button', { name: 'Run it' }).click();

  // Said at once, with what adds it, in the island and on the run's card.
  await expectIsland(page, /doesn’t have Playwright yet/);
  await expect(page.locator('[data-island]').getByRole('button', { name: 'Add Playwright to this app' })).toBeVisible();
  const add = page.locator('[data-add-playwright]');
  await expect(add).toHaveText('Add Playwright to this app');

  // One click: it is added, and the run it was needed for follows by itself (it fails for the real reason, the bug).
  await add.click();
  await expectIsland(page, /Test failed: expected “\$80\.80”, got “\$78\.40”/);
  expect(added).toBe(1);
  expect(runs).toBe(2);
  await expect(add).toHaveCount(0);
});
