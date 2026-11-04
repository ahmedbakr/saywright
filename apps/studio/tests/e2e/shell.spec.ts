/**
 * The studio's shell as a newcomer meets it: one welcome, then the quick-start
 * tour once an app is open (with typing as good as talking); a command palette that
 * reaches every top-level action and sends a request only when asked to; a top
 * bar that fits a 1024 px window; Write test mode showing what a check attaches to.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { appPoint, forgetTour, openStudio, resetAll, shopFile, store, STUDIO } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));

const call = async <T,>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${STUDIO}/api${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await res.json()) as T;
};
type Apps = { apps: { id: string; name: string; root: string | null }[] };
const shopId = async () => (await call<Apps>('GET', '/apps')).apps.find((a) => a.root?.endsWith('.e2e-shop'))!.id;

test.beforeEach(() => resetAll());
test.afterEach(async () => {
  await call('POST', `/apps/${await shopId()}/open`, { decide: 'undo' });
  for (const a of (await call<Apps>('GET', '/apps')).apps) if (!a.root?.endsWith('.e2e-shop')) await call('DELETE', `/apps/${a.id}`);
});

test('first run: the app list’s welcome comes alone, the quick-start tour follows once an app is open, and typing is as good as talking', async ({ page }) => {
  await forgetTour();
  await call('POST', '/apps/close');
  await page.addInitScript(() => localStorage.setItem('saywright.settings', JSON.stringify({ state: { theme: 'dark' }, version: 1 })));
  await page.goto('/');
  const list = page.getByRole('dialog', { name: 'Your apps' });
  await expect(list).toBeVisible();
  // Help, settings and the AI's status are there before anything is open.
  for (const name of ['Help', 'Settings']) await expect(list.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: /^AI/ })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator('[data-tour-card]')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Set up Saywright' })).toHaveCount(0);
  // The stage behind says plainly that no app is open (no “Still waiting for .”).
  await expect(page.locator('[data-no-app]')).toContainText('No app open');

  await list.locator('[data-open-app]').first().click();
  const tour = page.locator('[data-tour-card]');
  await expect(tour).toContainText('Point at something', { timeout: 30_000 });
  // One welcome: the setup dialog doesn't follow it.
  await expect(page.getByRole('dialog', { name: 'Set up Saywright' })).toHaveCount(0);
  // Typed, a request moves the tour on as a spoken one would; Ctrl Z from the empty bar undoes the preview.
  const before = shopFile('src/components/CouponField.tsx');
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await expect(tour).toContainText('Say what to change');
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it bigger');
  await page.keyboard.press('Enter');
  await expect(tour).toContainText('Keep it or undo it');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(tour).toContainText('See the code');
  expect(shopFile('src/components/CouponField.tsx')).toBe(before);
  await tour.getByRole('button', { name: 'Skip tour' }).click();
  await expect(tour).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('saywright.settings')!).state.onboarded)).toBe(true);
});

test('the command palette reaches every top-level action, and only its own row sends a request', async ({ page }) => {
  // A second app to switch to.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-plain-'));
  fs.cpSync(path.resolve(here, '../fixtures/apps/plain'), folder, { recursive: true });
  const { probe } = await call<{ probe: unknown }>('POST', '/apps/probe', { folder });
  await call('POST', '/apps', { probe, open: false });

  await openStudio(page);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const labels = await palette.locator('[cmdk-item] > span').allInnerTexts();
  for (const name of [
    'Edit: point and change',
    'Use: click through the app',
    'Write test: narrate a bug, get a Playwright test',
    'Record session: use the app, get a report',
    'Review this page with the Experts',
    'Autopilot: let the AI test your app…',
    'Sessions and their reports',
    'Switch to Lantern Notes',
    'Link an app…',
    'All apps',
    'Settings',
    'Settings: connect an AI',
    'Settings: usage and budget',
    'Phrases and shortcuts',
  ])
    expect(labels, name).toContain(name);

  // A command found by name runs on Enter; nothing goes to the AI.
  await page.keyboard.type('sessions');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Sessions/ })).toHaveAttribute('aria-selected', 'true');

  // What matches no command is not sent by Enter: only by its own row (Ctrl Enter, or a click).
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('make the header blue');
  await expect(palette.getByText('No command matches')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(palette).toBeVisible();
  expect(await store<string[]>(page, 's.history')).not.toContain('make the header blue');
  await expect(palette.locator('[data-send-request]')).toContainText('Send as a request: “make the header blue”');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(palette).toHaveCount(0);
  await expect.poll(() => store<string[]>(page, 's.history')).toContain('make the header blue');

  // Keep and undo are there while a preview waits.
  const before = shopFile('src/components/CouponField.tsx');
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it bigger');
  await page.keyboard.press('Enter');
  await expect.poll(() => shopFile('src/components/CouponField.tsx')).not.toBe(before);
  await page.mouse.click(8, 400);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette.getByRole('option', { name: /Keep the preview/ })).toBeVisible();
  await palette.getByRole('option', { name: /Undo the preview/ }).click();
  await expect.poll(() => shopFile('src/components/CouponField.tsx')).toBe(before);
});

async function controlBoxes(page: Page): Promise<{ name: string; x: number; y: number; w: number; h: number }[]> {
  return page.evaluate(() =>
    [...document.querySelector('header')!.querySelectorAll('button')]
      .filter((el) => el.getClientRects().length)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute('aria-label') || el.textContent!.trim(), x: r.x, y: r.y, w: r.width, h: r.height };
      }),
  );
}

test('at 1024 px the top bar fits: nothing overlaps, and the mode and session labels become icons that keep their names', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await openStudio(page, { onboarded: true, theme: 'light' });
  const boxes = await controlBoxes(page);
  for (const b of boxes) expect(b.x + b.w, `${b.name} inside the window`).toBeLessThanOrEqual(1024);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
      expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
    }
  // Icons only, with their names for screen readers, and a tooltip on focus.
  const write = page.getByRole('radio', { name: 'Write test' });
  expect((await write.boundingBox())!.width).toBeLessThan(40);
  expect((await page.getByRole('button', { name: 'Record session' }).boundingBox())!.width).toBeLessThan(40);
  await write.focus();
  await expect(page.getByRole('tooltip')).toContainText('Write test');

  // Wide enough, the labels show.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await write.boundingBox())!.width).toBeGreaterThan(60);
  expect((await page.getByRole('button', { name: 'Record session' }).boundingBox())!.width).toBeGreaterThan(80);
});

test('Write test mode boxes what the pointer is on, so a check you type attaches to what you see', async ({ page }) => {
  await openStudio(page);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  const total = await appPoint(page, 'summary-total', 0.85);
  await page.mouse.move(total.x - 40, total.y);
  await page.mouse.move(total.x, total.y, { steps: 4 });
  const box = page.locator('[data-hover-box="record"]');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Total');
});

test('a check typed in Write test is about what the pointer is on, not an element left selected in Edit mode', async ({ page }) => {
  await openStudio(page);
  // Selected while editing, then on to writing a test.
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await expect.poll(() => store<string | null>(page, 's.selection ? s.selection.name : null')).toBe('Button');
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  const total = await appPoint(page, 'summary-total', 0.85);
  await page.mouse.move(total.x - 40, total.y);
  await page.mouse.move(total.x, total.y, { steps: 4 });
  await expect(page.locator('[data-hover-box="record"]')).toContainText('Total');
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('this should show $80.80');
  await page.keyboard.press('Enter');
  await expect.poll(() => store<number>(page, 's.recorder.expectations.length')).toBe(1);
  expect(await store<string>(page, 's.recorder.expectations[0].locator')).toContain('summary-total');
});
