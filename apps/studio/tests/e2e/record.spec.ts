import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_SHOP, appPoint, expectIsland, openStudio, resetAll, shopFile, store } from './helpers';

test.beforeEach(() => resetAll());

test('narrate a bug → Playwright test → failing → fixed by Claude → passing → kept', async ({ page }) => {
  test.setTimeout(150_000);
  await openStudio(page);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');

  // Use the app normally: the recorder turns it into steps.
  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBe(2);
  await expect(app.getByTestId('summary-total')).toContainText('$78.40');

  // Point at the wrong total and say what it should show.
  const total = await appPoint(page, 'summary-total', 0.85);
  await page.mouse.move(total.x, total.y);
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('this should show $80.80');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
  expect(await store<string>(page, 's.recorder.expectations[0].locator')).toContain('summary-total');

  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const specPath = await store<string>(page, 's.recorder.spec.path');
  expect(fs.readFileSync(path.join(E2E_SHOP, specPath), 'utf8')).toContain("toContainText('$80.80')");

  await page.getByRole('button', { name: 'Run it' }).click();
  await expectIsland(page, /Test failed: expected “\$80\.80”, got “\$78\.40”/);

  await page.getByRole('button', { name: /^Fix with / }).first().click();
  await expectIsland(page, /The test passes with this fix/);
  expect(shopFile('src/lib/pricing.ts')).toContain('const discount = round2(subtotal * rate);');
  await page.getByRole('button', { name: 'Keep fix' }).click();
  await expectIsland(page, /Kept/);
  await expect(app.getByTestId('summary-total')).toContainText('$80.80');
});

test('a form sent with Enter is one step, and its generated test fails for the real reason', async ({ page }) => {
  test.setTimeout(150_000);
  await openStudio(page);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-input').press('Enter');
  await expect(app.getByTestId('summary-total')).toContainText('$78.40');
  // The browser “clicks” Apply itself after Enter: that click is not a step (the Enter sends the form).
  await expect.poll(() => store<string[]>(page, 's.recorder.steps.map((x) => x.kind)')).toEqual(['fill', 'press']);
  await page.waitForTimeout(500);
  expect(await store<string[]>(page, 's.recorder.steps.map((x) => x.kind)')).toEqual(['fill', 'press']);

  const total = await appPoint(page, 'summary-total', 0.85);
  await page.mouse.move(total.x, total.y);
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('this should show $80.80');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const spec = fs.readFileSync(path.join(E2E_SHOP, await store<string>(page, 's.recorder.spec.path')), 'utf8');
  expect(spec).toContain(".press('Enter')");
  expect(spec).not.toContain('coupon-apply');
  // It fails on the wrong total, not on a button that is gone once the coupon is applied.
  await page.getByRole('button', { name: 'Run it' }).click();
  await expectIsland(page, /Test failed: expected “\$80\.80”, got “\$78\.40”/);
});

test('a step on one of several identical buttons is written so a test finds the same one, without code positions', async ({ page }) => {
  test.setTimeout(150_000);
  await openStudio(page);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  const app = page.frameLocator('iframe');
  await app.getByRole('link', { name: 'Shop', exact: true }).click();
  await app.getByRole('article').filter({ hasText: 'Celadon mug' }).getByRole('button', { name: 'Add to cart' }).click();
  await app.getByRole('link', { name: 'Checkout', exact: true }).click();
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBe(5);
  expect(await store<string>(page, 's.recorder.steps[1].description')).toBe('Click “Add to cart” for “Celadon mug, 12 oz”');

  const total = await appPoint(page, 'summary-total', 0.85);
  await page.mouse.move(total.x, total.y);
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('this should show $80.80');
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const spec = fs.readFileSync(path.join(E2E_SHOP, await store<string>(page, 's.recorder.spec.path')), 'utf8');
  expect(spec).toContain("await page.getByRole('article').filter({ hasText: 'Celadon mug, 12 oz' }).getByRole('button', { name: 'Add to cart' }).click();");
  expect(spec).not.toMatch(/data-ds-src|\.tsx:\d+|\.nth\(/);
  // Playwright follows every step to the wrong total.
  await page.getByRole('button', { name: 'Run it' }).click();
  await expectIsland(page, /Test failed: expected “\$80\.80”, got “\$78\.40”/);
});
