import { expect, test } from '@playwright/test';
import { appPoint, expectIsland, openStudio, pinchTap, resetAll, setHand, shopFile, startHand, store } from './helpers';

test.beforeEach(() => resetAll());

test('point with the hand and pinch to select', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const pay = await appPoint(page, 'pay-button', 0.3);
  await setHand(page, { pose: 'pointing_up', x: pay.x, y: pay.y });
  await expect.poll(() => store<string>(page, 's.hover?.label')).toContain('Pay');
  await pinchTap(page);
  await expect.poll(() => store<string>(page, 's.selection?.label')).toContain('Pay');
});

test('a pinch selects what the finger pointed at, the moment the fingers meet, though the fingertip moves as they close', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  // Rows 38 px apart: a fingertip that drifts while pinching lands on another one.
  const subtotal = await appPoint(page, 'summary-subtotal', 0.12);
  await setHand(page, { pose: 'pointing_up', x: subtotal.x, y: subtotal.y });
  await expect.poll(() => store<string>(page, 's.hover?.label')).toMatch(/Subtotal/);
  await page.waitForTimeout(300);
  // Close the fingers the way a hand does, and hold: selected before letting go.
  for (const k of [0.35, 0.7, 1]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  await expect.poll(() => store<string>(page, 's.selection?.label'), { timeout: 2000 }).toMatch(/Subtotal/);
  // The fingertip itself went down past the next rows.
  const tip = await page.evaluate(() => {
    const e = (window as any).__saywright.engine;
    return e.toScreen(e.state.landmarks[8]);
  });
  expect(tip.y - subtotal.y).toBeGreaterThan(60);
  for (const k of [0.6, 0.25, 0]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
  expect(await store<string>(page, 's.selection?.label')).toMatch(/Subtotal/);
});

test('pinch and move scrolls without changing the selection', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const pay = await appPoint(page, 'pay-button', 0.3);
  await setHand(page, { pose: 'pointing_up', x: pay.x, y: pay.y });
  await page.waitForTimeout(300);
  await pinchTap(page);
  await expect.poll(() => store<string>(page, 's.selection?.label')).toContain('Pay');
  const total = await appPoint(page, 'summary-total', 0.12);
  await setHand(page, { x: total.x, y: total.y });
  await page.waitForTimeout(400);
  for (const k of [0.5, 1]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(60);
  }
  for (let i = 1; i <= 8; i++) {
    await setHand(page, { y: total.y - i * 12 });
    await page.waitForTimeout(40);
  }
  await setHand(page, { pinch: 0 });
  await page.waitForTimeout(300);
  expect(await store<string>(page, 's.selection?.label')).toContain('Pay');
});

test('the highlight holds steady at the edge between two rows', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const sub = await page.frameLocator('iframe').getByTestId('summary-subtotal').boundingBox();
  const ship = await page.frameLocator('iframe').getByTestId('summary-shipping').boundingBox();
  const x = sub!.x + sub!.width * 0.12;
  const at = async (y: number) => {
    await setHand(page, { pose: 'pointing_up', x, y });
    await page.waitForTimeout(450);
    return store<string>(page, 's.hover?.label');
  };
  expect(await at(sub!.y + sub!.height / 2)).toMatch(/Subtotal/);
  // Just past its bottom edge, in the gap: still the row you were on.
  expect(await at(sub!.y + sub!.height + 3)).toMatch(/Subtotal/);
  expect(await at(ship!.y + ship!.height / 2)).toMatch(/Shipping/);
  // And coming back up into the gap, still Shipping.
  expect(await at(ship!.y - 3)).toMatch(/Shipping/);
});

test('aim assist snaps to a small target next to the fingertip', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const b = await page.frameLocator('iframe').getByTestId('coupon-apply').boundingBox();
  // Just outside the button's edge.
  await setHand(page, { pose: 'pointing_up', x: b!.x + b!.width + 10, y: b!.y + b!.height / 2 });
  await expect.poll(() => store<string>(page, 's.hover?.label')).toContain('Apply');
});

test('“make this bigger” while pointing, then thumbs up keeps it', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const apply = await appPoint(page, 'coupon-apply');
  await setHand(page, { pose: 'pointing_up', x: apply.x, y: apply.y });
  await page.waitForTimeout(400);
  await page.keyboard.down('Space');
  await expect.poll(() => store<string>(page, 's.voice.state')).toBe('listening');
  await page.evaluate(() => (window as any).__speech.say('make this bigger'));
  await page.waitForTimeout(300);
  await page.keyboard.up('Space');
  await expectIsland(page, /Apply.*size sm → md/);
  expect(shopFile('src/components/CouponField.tsx')).toContain('<Button variant="secondary" type="submit" data-testid="coupon-apply">');
  // Thumb up, held: keep.
  await setHand(page, { pose: 'thumbs_up' });
  await expect.poll(() => store<string>(page, 's.changes[0].status')).toBe('kept');
});

test('“make this look like that” binds each word to what you pointed at', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const apply = await appPoint(page, 'coupon-apply');
  const pay = await appPoint(page, 'pay-button', 0.3);
  await setHand(page, { pose: 'pointing_up', x: apply.x, y: apply.y });
  await page.waitForTimeout(400);
  await page.keyboard.down('Space');
  await page.evaluate(() => (window as any).__speech.say('make this'));
  await page.waitForTimeout(600);
  await setHand(page, { x: pay.x, y: pay.y });
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__speech.say('make this look like that'));
  await page.waitForTimeout(600);
  await page.keyboard.up('Space');
  await expectIsland(page, /Apply.*looks like.*Pay/);
  // Thumb down undoes.
  await setHand(page, { pose: 'thumbs_down' });
  await expect.poll(() => store<string>(page, 's.changes[0].status')).toBe('undone');
});

test('peace sign starts listening hands-free; a pause sends', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const pay = await appPoint(page, 'pay-button', 0.3);
  await setHand(page, { pose: 'victory', x: pay.x, y: pay.y });
  await expect.poll(() => store<string>(page, 's.voice.state')).toBe('listening');
  const apply = await appPoint(page, 'coupon-apply');
  await setHand(page, { pose: 'pointing_up', x: apply.x, y: apply.y });
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__speech.say('rename this to Use code'));
  // Hands-free stops by itself after the pause.
  await expectIsland(page, /Rename/);
  await expect(page.frameLocator('iframe').getByTestId('coupon-apply')).toHaveText('Use code');
  await setHand(page, { pose: 'thumbs_down' });
  await expect.poll(() => store<string>(page, 's.changes[0].status')).toBe('undone');
});

test('open palm stops listening and clears the selection', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const pay = await appPoint(page, 'pay-button', 0.3);
  await setHand(page, { pose: 'pointing_up', x: pay.x, y: pay.y });
  await page.waitForTimeout(300);
  await pinchTap(page);
  await expect.poll(() => store<string>(page, 's.selection?.label')).toContain('Pay');
  await setHand(page, { pose: 'x_right_hands' });
  await expect.poll(() => store<unknown>(page, 's.selection')).toBeNull();
});

test('the hand drives studio controls too', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  const use = await page.getByRole('radio', { name: /Use/ }).boundingBox();
  await setHand(page, { pose: 'pointing_up', x: use!.x + use!.width / 2, y: use!.y + use!.height / 2 });
  await expect(page.getByRole('radio', { name: /Use/ })).toHaveAttribute('data-hand-hover', '');
  await pinchTap(page);
  await expect.poll(() => store<string>(page, 's.mode')).toBe('use');
});

test('in Use mode a pinch clicks for real', async ({ page }) => {
  await openStudio(page);
  await startHand(page);
  await page.keyboard.press('u');
  const input = await appPoint(page, 'coupon-input');
  await setHand(page, { pose: 'pointing_up', x: input.x, y: input.y });
  await page.waitForTimeout(300);
  await pinchTap(page);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('type SAVE20');
  await page.keyboard.press('Enter');
  await expect(page.frameLocator('iframe').getByTestId('coupon-input')).toHaveValue('SAVE20');
});
