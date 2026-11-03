import { expect, test, type Page } from '@playwright/test';
import { openStudio, resetAll, setHand, startHand } from './helpers';

test.beforeEach(() => resetAll());

/** Calibrate by holding still at each corner; the reach found is the one the hand covered. */
async function calibrate(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder('Search commands…').fill('calibrate');
  await page.getByRole('option', { name: /Calibrate reach/ }).click();
  await expect(page.getByText('Point at the top left target')).toBeVisible();
  // A user whose comfortable reach covers the middle of the camera image (mirrored x).
  const reach = { x0: 0.3, x1: 0.7, y0: 0.25, y1: 0.65 };
  const inset = 0.07;
  const corners: [string, number, number][] = [
    ['top left', inset, inset],
    ['top right', 1 - inset, inset],
    ['bottom right', 1 - inset, 1 - inset],
    ['bottom left', inset, 1 - inset],
  ];
  for (const [label, sx, sy] of corners) {
    await expect(page.getByText(`Point at the ${label} target`)).toBeVisible({ timeout: 15_000 });
    const mirroredX = reach.x0 + sx * (reach.x1 - reach.x0);
    await setHand(page, { pose: 'pointing_up', raw: { x: 1 - mirroredX, y: reach.y0 + sy * (reach.y1 - reach.y0) } });
    // Hold still until this corner is captured and the next one is asked for.
    await expect(page.getByText(`Point at the ${label} target`)).toBeHidden({ timeout: 15_000 });
  }
  await expect(page.getByText('Reach calibrated')).toBeVisible();
  const box = await page.evaluate(() => (window as any).__saywrightSettings.getState().engine.box);
  expect(box.x0).toBeCloseTo(reach.x0, 2);
  expect(box.x1).toBeCloseTo(reach.x1, 2);
  expect(box.y0).toBeCloseTo(reach.y0, 2);
  expect(box.y1).toBeCloseTo(reach.y1, 2);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Reach calibrated')).toBeHidden();
}

test('calibrating reach maps four held points to the whole screen', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  await calibrate(page);
});

test('holding still counts however the camera’s frames fall: 25 a second, exactly 40 ms apart', async ({ page }) => {
  await openStudio(page);
  await startHand(page, { frameMs: 40, steady: true });
  await calibrate(page);
});
