/**
 * The studio's own accessibility: its main screens pass axe-core (the engine
 * the Experts use) for WCAG 2.2 AA and best practice, in light and dark; its
 * overlays are real modals (the studio behind them inert, focus moved in, kept
 * in and given back); and Escape closes only the layer on top.
 */
import { expect, test, type Page } from '@playwright/test';
import { appPoint, openStudio, resetAll, SHOP_URL, store, STUDIO } from './helpers';

test.beforeEach(() => resetAll());

const post = async (route: string, body: unknown) => (await fetch(`${STUDIO}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

/** A finished session with a failed request and an error, so its report has findings. */
async function finishedSession(): Promise<string> {
  const { session } = await post('/sessions', { name: 'Checkout check', appUrl: `${SHOP_URL}/`, source: 'studio', lang: 'en' });
  const t = session.startedAt as number;
  await post(`/sessions/${session.id}/events`, {
    page: 'p1',
    events: [
      { seq: 1, t: t + 100, type: 'page', url: `${SHOP_URL}/#/checkout`, title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false },
      { seq: 2, t: t + 1000, type: 'net', via: 'fetch', method: 'POST', url: '/api/coupon', status: 500, ok: false, ms: 120, body: 'boom' },
      { seq: 3, t: t + 2000, type: 'error', kind: 'error', message: 'Cannot read properties of undefined (reading total)', stack: `TypeError: x\n    at apply (${SHOP_URL}/src/lib/pricing.ts:32:11)` },
    ],
  });
  await post(`/sessions/${session.id}/stop`, {});
  await expect.poll(async () => (await (await fetch(`${STUDIO}/api/sessions/${session.id}`)).json()).meta.status, { timeout: 60_000 }).toBe('ready');
  return session.id;
}

/** axe-core over the studio's document (the app's frame is the app's business), once what was opened has finished fading in. */
async function expectAxeClean(page: Page, screen: string): Promise<void> {
  await page.waitForTimeout(450);
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ url: '/axe.min.js' });
  const found = await page.evaluate(async () => {
    type Result = { violations: { id: string; impact: string; nodes: { target: string[]; any: { message: string }[]; all: { message: string }[]; none: { message: string }[] }[] }[] };
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<Result> } }).axe;
    const r = await axe.run({ exclude: [['iframe']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} — ${(n.any[0] ?? n.all[0] ?? n.none[0])?.message ?? ''}`).join(' | ')}`);
  });
  expect(found, `axe on ${screen}`).toEqual([]);
}

const inert = (page: Page, selector: string) => page.evaluate((s) => !!document.querySelector(s)?.closest('[inert]'), selector);
const focusedIn = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);

for (const theme of ['light', 'dark'] as const) {
  test(`the main screens pass axe in the ${theme} theme`, async ({ page }) => {
    test.setTimeout(150_000);
    const report = await finishedSession();
    await openStudio(page, { onboarded: true, theme });
    await expectAxeClean(page, 'the studio');

    const apply = await appPoint(page, 'coupon-apply');
    await page.mouse.click(apply.x, apply.y);
    await page.getByRole('tab', { name: /Inspect/ }).click();
    await expect(page.getByText('src/components/CouponField.tsx:45')).toBeVisible();
    await expectAxeClean(page, 'Inspect');

    await page.getByRole('radio', { name: 'Write test' }).click();
    await expect(page.getByText('Recording your steps')).toBeVisible();
    await expectAxeClean(page, 'Write test mode');
    await page.getByRole('radio', { name: 'Edit' }).click();

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByPlaceholder('Search commands…')).toBeFocused();
    await expectAxeClean(page, 'the command palette');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Help' }).click();
    await expectAxeClean(page, 'help');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Settings' }).click();
    await expectAxeClean(page, 'settings');
    await page.keyboard.press('Escape');

    await page.locator('[data-app-switcher]').click();
    await page.getByRole('menuitem', { name: 'All apps' }).click();
    await expectAxeClean(page, 'the app list');
    await page.locator('[data-link-app]').click();
    await expectAxeClean(page, 'linking an app');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-launcher]')).toHaveCount(0);

    // The quick-start tour on the live studio: its first step, and one pointing at the command bar.
    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByRole('button', { name: 'Take the tour' }).click();
    await expect(page.locator('[data-tour-card]')).toBeFocused();
    await expectAxeClean(page, 'the quick-start tour');
    await page.locator('[data-tour-next]').click();
    await expect(page.locator('[data-tour-ring]')).toHaveCount(1);
    await expectAxeClean(page, 'the quick-start tour’s second step');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tour-card]')).toHaveCount(0);

    // The setup's voice check.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('Talk to it')).toBeVisible();
    await expectAxeClean(page, 'the voice check');
    await page.keyboard.press('Escape');

    await page.goto(`/report/${report}`);
    await expect(page.locator('[data-findings]')).toBeVisible({ timeout: 20_000 });
    await expectAxeClean(page, 'a session report');
  });
}

test('the app list is a real modal: the studio behind is inert, Tab stays inside, Escape gives focus back', async ({ page }) => {
  await openStudio(page);
  await page.locator('[data-app-switcher]').click();
  await page.getByRole('menuitem', { name: 'All apps' }).click();
  const list = page.getByRole('dialog', { name: 'Your apps' });
  await expect(list).toHaveAttribute('aria-modal', 'true');
  // Focus starts on the first app's Open button; the studio can't be reached.
  await expect(list.locator('[data-open-app]').first()).toBeFocused();
  expect(await inert(page, '[data-stage]')).toBe(true);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await focusedIn(page, '[data-launcher]')).toBe(true);
  }
  // Studio shortcuts wait while it is open: R doesn't switch modes, Space doesn't start the microphone.
  await list.locator('[data-link-app]').focus();
  await page.keyboard.press('r');
  expect(await store<string>(page, 's.mode')).toBe('edit');
  await page.keyboard.down('Space');
  expect(await store<string>(page, 's.voice.state')).toBe('idle');
  await page.keyboard.up('Space');
  // Space pressed the focused button instead, and Escape closes what it opened first.
  await expect(page.getByRole('dialog', { name: 'Link an app' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Link an app' })).toHaveCount(0);
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-launcher]')).toHaveCount(0);
  await expect(page.locator('[data-app-switcher]')).toBeFocused();
  expect(await inert(page, '[data-stage]')).toBe(false);
});

test('the quick-start tour is not a modal: nothing goes inert, focus moves in once and isn’t kept, each step is announced', async ({ page }) => {
  await openStudio(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('quick-start tour');
  await page.keyboard.press('Enter');
  const card = page.getByRole('dialog', { name: 'Point at something' });
  await expect(card).toBeFocused();
  await expect(card).not.toHaveAttribute('aria-modal', 'true');
  expect(await inert(page, '[data-stage]')).toBe(false);
  // Tab goes on through the studio.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  expect(await focusedIn(page, '[data-tour-card]')).toBe(false);
  // Doing the step moves the tour on; focus stays where the person works, and screen readers hear the new step.
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await expect(page.getByRole('dialog', { name: 'Say what to change' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Step 2 of 8: Say what to change.' })).toHaveCount(1);
  expect(await focusedIn(page, '[data-tour-card]')).toBe(false);
  // Escape ends it; the selection, under it, stays.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tour-card]')).toHaveCount(0);
  expect(await store<string | null>(page, 's.selection?.name ?? null')).toBe('Button');
});

test('dialogs are modal and give focus back where it was', async ({ page }) => {
  await openStudio(page);
  const help = page.getByRole('button', { name: 'Help' });
  await help.click();
  const dialog = page.getByRole('dialog', { name: 'Phrases and shortcuts' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(await inert(page, '[data-stage]')).toBe(true);
  expect(await focusedIn(page, '[role="dialog"]')).toBe(true);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await focusedIn(page, '[role="dialog"]')).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(help).toBeFocused();
  expect(await inert(page, '[data-stage]')).toBe(false);
});

test('Escape closes only the layer on top: the selection survives help, the palette and a menu', async ({ page }) => {
  await openStudio(page);
  const apply = await appPoint(page, 'coupon-apply');
  await page.mouse.click(apply.x, apply.y);
  await expect.poll(() => store<string | null>(page, 's.selection?.name ?? null')).toBe('Button');
  const selected = () => store<boolean>(page, '!!s.selection');

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Phrases and shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await selected()).toBe(true);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await selected()).toBe(true);

  await page.locator('[data-app-switcher]').click();
  await expect(page.getByRole('menuitem', { name: 'All apps' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'All apps' })).toHaveCount(0);
  expect(await selected()).toBe(true);

  // With nothing open, Escape is the studio's again: it stops what is going on, then clears the selection.
  await expect
    .poll(async () => {
      await page.keyboard.press('Escape');
      return selected();
    })
    .toBe(false);
});
