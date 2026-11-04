/**
 * Selecting, the way people do it with the mouse: a click selects what is
 * highlighted, the same click again deselects it, ⇧ click adds (or takes out),
 * and the arrow keys and the voice move the selection.
 */
import { expect, test, type Page } from '@playwright/test';
import { appPoint, openStudio, resetAll, selectedLabels, store } from './helpers';

test.beforeEach(() => resetAll());

async function pointAt(page: Page, testId: string, fx = 0.3): Promise<{ x: number; y: number }> {
  const p = await appPoint(page, testId, fx);
  await page.mouse.move(p.x, p.y);
  await expect.poll(() => store<string | null>(page, 's.hover && s.hover.label')).toBeTruthy();
  await page.waitForTimeout(250);
  return p;
}

async function say(page: Page, text: string): Promise<void> {
  await page.keyboard.down('Space');
  await page.evaluate((t) => (window as any).__speech.say(t), text);
  await page.waitForTimeout(400);
  await page.keyboard.up('Space');
}

test('the mouse does the same: click selects, again deselects, ⇧ click adds; arrow keys move it', async ({ page }) => {
  await openStudio(page);
  const click = async (testId: string, fx = 0.3, shift = false) => {
    const p = await appPoint(page, testId, fx);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(150);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    if (shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(600); // not a double click
  };
  await click('pay-button');
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Pay')]);
  await click('pay-button');
  await expect.poll(() => selectedLabels(page)).toEqual([]);
  await click('pay-button');
  await click('summary-subtotal', 0.12, true);
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Pay'), expect.stringContaining('Subtotal')]);
  // A double click selects, like a single one.
  const total = await appPoint(page, 'summary-total', 0.12);
  await page.mouse.dblclick(total.x, total.y);
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Total')]);
  await page.waitForTimeout(600);

  await click('summary-subtotal', 0.12);
  const row = await store<string>(page, 's.selection.label');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => store<string>(page, 's.selection.label')).toContain('Shipping');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => store<string>(page, 's.selection.label')).toBe(row);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => store<string>(page, 's.selection.label')).not.toBe(row);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => store<string>(page, 's.selection.label')).toBe(row);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => store<string>(page, 's.selection.name')).toBe('div');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => store<string>(page, 's.selection.name')).toBe('Card');

  // In a list, the next one is the same part of the next item.
  const price = (await page.frameLocator('iframe').getByText('$54.00').boundingBox())!;
  await page.mouse.click(price.x + price.width / 2, price.y + price.height / 2);
  await expect.poll(() => store<string>(page, 's.selection.text')).toBe('$54.00');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => store<string>(page, 's.selection.text')).toBe('$32.00');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-island]')).toContainText('That’s the last one.');
});

test('the voice moves the selection: next, the card, inside, add this, deselect', async ({ page }) => {
  await openStudio(page);
  const sub = await pointAt(page, 'summary-subtotal', 0.12);
  await page.mouse.click(sub.x, sub.y);
  await expect.poll(() => store<string>(page, 's.selection.label')).toContain('Subtotal');
  await say(page, 'next');
  await expect.poll(() => store<string>(page, 's.selection.label')).toContain('Shipping');
  await say(page, 'the card');
  await expect.poll(() => store<string>(page, 's.selection.name')).toBe('Card');
  // The nearest button inside the card (the coupon's is a level deeper).
  await say(page, 'the button inside');
  await expect.poll(() => store<string>(page, 's.selection.label')).toMatch(/^Button · Pay/);
  // Pointing at another, then saying it (what was pointed at as “this” was said counts, not what came before).
  await pointAt(page, 'coupon-apply', 0.5);
  await page.waitForTimeout(800);
  await say(page, 'add this');
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringMatching(/^Button · Pay/), expect.stringContaining('Apply')]);
  await say(page, 'deselect');
  await expect.poll(() => selectedLabels(page)).toEqual([]);
});
