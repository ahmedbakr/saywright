/**
 * Selecting, the way people do it: one pinch selects what is highlighted, the
 * same pinch again deselects it, a pinch on empty space clears, holding the
 * pinch adds (or takes out), and only a deliberate move scrolls, leaving the
 * selection alone. The mouse, the arrow keys and the voice do the same.
 */
import { expect, test, type Page } from '@playwright/test';
import { appPoint, openStudio, pinchHold, pinchTap, resetAll, selectedLabels, setHand, startHand, store } from './helpers';

test.beforeEach(() => resetAll());

async function pointAt(page: Page, testId: string, fx = 0.3): Promise<{ x: number; y: number }> {
  const p = await appPoint(page, testId, fx);
  await setHand(page, { pose: 'pointing_up', x: p.x, y: p.y });
  await expect.poll(() => store<string | null>(page, 's.hover && s.hover.label')).toBeTruthy();
  await page.waitForTimeout(250);
  return p;
}

const hint = (page: Page) => page.locator('[data-pinch-hint]').innerText();

async function say(page: Page, text: string): Promise<void> {
  await page.keyboard.down('Space');
  await page.evaluate((t) => (window as any).__speech.say(t), text);
  await page.waitForTimeout(400);
  await page.keyboard.up('Space');
}

test('one pinch selects, the same pinch again deselects, a pinch elsewhere moves the selection', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  await pointAt(page, 'pay-button');
  // Before pinching, it says what a pinch will do.
  await expect.poll(() => hint(page)).toMatch(/Pinch\s+to select$/);
  await pinchTap(page);
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Pay')]);
  await expect.poll(() => hint(page)).toMatch(/Pinch\s+to deselect$/);
  await pinchTap(page);
  await expect.poll(() => selectedLabels(page)).toEqual([]);
  await pinchTap(page);
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Pay')]);
  await pointAt(page, 'summary-subtotal', 0.12);
  await expect.poll(() => hint(page)).toMatch(/Pinch\s+to select.*Hold\s+to add/s);
  await pinchTap(page);
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Subtotal')]);
});

test('holding the pinch adds to the selection, numbered in order, and takes out again', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  await pointAt(page, 'pay-button');
  await pinchTap(page);
  await pointAt(page, 'summary-subtotal', 0.12);
  await pinchHold(page);
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Pay'), expect.stringContaining('Subtotal')]);
  await expect(page.locator('[data-picked="1"]')).toBeVisible();
  await expect(page.locator('[data-island]')).toContainText('2 selected');
  // On one of them: a pinch would keep only it, a hold takes it out.
  await pointAt(page, 'pay-button');
  await expect.poll(() => hint(page)).toMatch(/Pinch\s+to select only this.*Hold\s+to take out/s);
  await pinchHold(page);
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Subtotal')]);
});

test('a pinch that wanders a little still selects; only a deliberate move scrolls, and the selection stays', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const pay = await pointAt(page, 'pay-button');
  // Fingers close, the hand wanders about 20 px either way meanwhile, fingers open.
  for (const k of [0.35, 0.7, 1]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  for (const [dx, dy] of [[14, 6], [-10, 16], [22, -8], [-6, -18], [8, 4]]) {
    await setHand(page, { x: pay.x + dx, y: pay.y + dy });
    await page.waitForTimeout(45);
  }
  for (const k of [0.6, 0.25, 0]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  await expect.poll(() => selectedLabels(page)).toEqual([expect.stringContaining('Pay')]);
  expect(await store<boolean>(page, 's.hand.dragging')).toBe(false);

  // A clear move scrolls, and leaves Pay selected (not what the pinch started on).
  const total = await pointAt(page, 'summary-total', 0.12);
  for (const k of [0.5, 1]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(60);
  }
  let dragged = false;
  for (let i = 1; i <= 12; i++) {
    await setHand(page, { y: total.y - i * 14 });
    await page.waitForTimeout(40);
    dragged ||= await store<boolean>(page, 's.hand.dragging');
  }
  await setHand(page, { pinch: 0 });
  await page.waitForTimeout(300);
  expect(dragged).toBe(true);
  expect(await selectedLabels(page)).toEqual([expect.stringContaining('Pay')]);
});

test('a pinch on empty space clears the selection', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  await pointAt(page, 'pay-button');
  await pinchTap(page);
  await pointAt(page, 'summary-subtotal', 0.12);
  await pinchHold(page);
  await expect.poll(() => selectedLabels(page)).toHaveLength(2);
  // Somewhere on the page's own background, with nothing to highlight nearby.
  const spot = await page.evaluate(async () => {
    const c = (window as any).__saywright;
    const frame = document.querySelector('iframe')!.getBoundingClientRect();
    for (let fy = 0.15; fy < 0.99; fy += 0.03) {
      for (let fx = 0.03; fx < 0.98; fx += 0.03) {
        const x = frame.left + frame.width * fx;
        const y = frame.top + frame.height * fy;
        if (c.hitStudio(x, y).kind !== 'app') continue;
        const a = c.toApp(x, y);
        if (!(await c.bridge.probeAt(a.x, a.y, 34, false))) return { x, y };
      }
    }
    return null;
  });
  expect(spot).toBeTruthy();
  await setHand(page, { x: spot!.x, y: spot!.y });
  await expect.poll(() => store<unknown>(page, 's.hover')).toBeNull();
  await expect(page.locator('[data-pinch-hint]')).toHaveCount(0);
  await page.waitForTimeout(200);
  await pinchTap(page);
  await expect.poll(() => selectedLabels(page)).toEqual([]);
});

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
  await startHand(page);
  await pointAt(page, 'summary-subtotal', 0.12);
  await pinchTap(page);
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

test('with “select by resting” on, pointing at something for a second selects it', async ({ page }) => {
  await openStudio(page, { onboarded: true, theme: 'dark', dwellSelect: true });
  await startHand(page);
  await pointAt(page, 'pay-button');
  await expect.poll(() => selectedLabels(page), { timeout: 3000 }).toEqual([expect.stringContaining('Pay')]);
  // Passing over something on the way doesn't.
  const sub = await appPoint(page, 'summary-subtotal', 0.12);
  const ship = await appPoint(page, 'summary-shipping', 0.12);
  await setHand(page, { x: sub.x, y: sub.y });
  await page.waitForTimeout(450);
  await setHand(page, { x: ship.x, y: ship.y });
  await page.waitForTimeout(450);
  await setHand(page, { pose: null });
  await page.waitForTimeout(800);
  expect(await selectedLabels(page)).toEqual([expect.stringContaining('Pay')]);
});
