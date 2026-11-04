/**
 * “This” and “that” are what the mouse was on while each word was said.
 */
import { expect, test } from '@playwright/test';
import { appPoint, expectIsland, openStudio, resetAll, shopFile, store } from './helpers';

test.beforeEach(() => resetAll());

test('“make this bigger” while pointing at a button, then Enter keeps it', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.move(apply.x, apply.y);
  await expect.poll(() => store<string | null>(page, 's.hover && s.hover.label')).toContain('Apply');
  await page.waitForTimeout(300);
  await page.keyboard.down('Space');
  await expect.poll(() => store<string>(page, 's.voice.state')).toBe('listening');
  await page.evaluate(() => (window as any).__speech.say('make this bigger'));
  await page.waitForTimeout(300);
  await page.keyboard.up('Space');
  await expectIsland(page, /Apply.*size sm → md/);
  expect(shopFile('src/components/CouponField.tsx')).toContain('<Button variant="secondary" type="submit" data-testid="coupon-apply">');
  await page.keyboard.press('Enter');
  await expect.poll(() => store<string>(page, 's.changes[0].status')).toBe('kept');
});

test('“make this look like that” binds each word to what the mouse was on', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  const pay = await appPoint(page, 'pay-button', 0.3);
  await page.mouse.move(apply.x, apply.y);
  await expect.poll(() => store<string | null>(page, 's.hover && s.hover.label')).toContain('Apply');
  await page.waitForTimeout(400);
  // One sentence, said as the mouse moves: “this” while it is on Apply, “that” once it is on Pay.
  await page.keyboard.down('Space');
  await expect.poll(() => store<string>(page, 's.voice.state')).toBe('listening');
  await page.evaluate(() => void (window as any).__speech.say('make this look like that', 500));
  await page.waitForTimeout(1000);
  await page.mouse.move(pay.x, pay.y, { steps: 4 });
  await page.waitForTimeout(1800);
  await page.keyboard.up('Space');
  await expectIsland(page, /Apply.*looks like.*Pay/);
  await page.keyboard.press('Control+z');
  await expect.poll(() => store<string>(page, 's.changes[0].status')).toBe('undone');
});
