/**
 * What a session records, in the order it happened: steps that can be played
 * back (a test, or a replay after a fix) must keep typing before the click
 * that sends it, however fast the click comes.
 */
import { expect, test } from '@playwright/test';
import { openStudio, resetAll, STUDIO } from './helpers';

test.beforeEach(async ({ page }) => {
  await resetAll();
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
});

test('typing, then clicking at once: the steps keep that order', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const app = page.frameLocator('iframe');
  // Typed, then Apply clicked straight away (well within the pause the recorder waits for after typing).
  await app.getByTestId('coupon-input').pressSequentially('SAVE20', { delay: 20 });
  await app.getByTestId('coupon-apply').click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report ready' })).toBeVisible({ timeout: 60_000 });
  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string }[] };
  const d = (await (await fetch(`${STUDIO}/api/sessions/${sessions[0].id}`)).json()) as { analysis: { steps: { kind: string; value?: string; locator?: string }[] } };
  const steps = d.analysis.steps.filter((s) => s.kind !== 'navigate').map((s) => `${s.kind}${s.value ? ` ${s.value}` : ''}`);
  expect(steps).toEqual(['fill SAVE20', 'click']);
});

test('typing, then Enter to send the form: the steps are the typing and the Enter, not a click', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: /^(Test|Record) session$/ }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').pressSequentially('SAVE20', { delay: 20 });
  await app.getByTestId('coupon-input').press('Enter');
  await expect(app.getByTestId('summary-total')).toContainText('$78.40');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report ready' })).toBeVisible({ timeout: 60_000 });
  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string }[] };
  const d = (await (await fetch(`${STUDIO}/api/sessions/${sessions[0].id}`)).json()) as { analysis: { steps: { kind: string; value?: string }[]; timeline: { text: string }[] } };
  const steps = d.analysis.steps.filter((s) => s.kind !== 'navigate').map((s) => `${s.kind}${s.value ? ` ${s.value}` : ''}`);
  expect(steps).toEqual(['fill SAVE20', 'press']);
  // The form is named by its field, not by its words run together (“CouponApply”).
  const submitted = d.analysis.timeline.find((t) => t.text.startsWith('Submitted'));
  expect(submitted?.text).toContain('Coupon');
  expect(submitted?.text).not.toContain('CouponApply');
});

test('the same button on several cards is told apart by its card: in the steps, the timeline and a replay', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const app = page.frameLocator('iframe');
  await app.getByRole('link', { name: 'Shop', exact: true }).click();
  // Six cards, six “Add to cart” buttons: the second one, the mug's.
  await app.getByRole('article').filter({ hasText: 'Celadon mug' }).getByRole('button', { name: 'Add to cart' }).click();
  await expect(app.getByRole('status')).toContainText('Added Celadon mug');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report ready' })).toBeVisible({ timeout: 60_000 });
  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string }[] };
  const d = (await (await fetch(`${STUDIO}/api/sessions/${sessions[0].id}`)).json()) as { analysis: { steps: { kind: string; locator?: string; description: string }[]; timeline: { text: string }[] } };
  const add = d.analysis.steps.find((s) => s.kind === 'click' && s.description.includes('Add to cart'))!;
  expect(add).toMatchObject({ description: 'Click “Add to cart” for “Celadon mug, 12 oz”', locator: "page.getByRole('article').filter({ hasText: 'Celadon mug, 12 oz' }).getByRole('button', { name: 'Add to cart' })" });
  expect(d.analysis.timeline.map((x) => x.text)).toContain('Clicked “Add to cart” for “Celadon mug, 12 oz”');
  // Nothing that only the dev server knows (where the code is written).
  expect(JSON.stringify(d.analysis.steps)).not.toMatch(/data-ds-src|\.tsx:\d+/);

  // Played again, it is the mug's button that is clicked.
  await expect(app.getByRole('status')).toHaveCount(0, { timeout: 5000 });
  const replayed = await page.evaluate((loc) => (window as unknown as { __saywright: { bridge: { replay: (...a: unknown[]) => Promise<{ ok: boolean }> } } }).__saywright.bridge.replay(loc, { kind: 'click' }), add.locator!);
  expect(replayed.ok).toBe(true);
  await expect(app.getByRole('status')).toContainText('Added Celadon mug');
});

test('what the screen showed once an action settled is kept for the report, tied to that action', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect(app.getByTestId('summary-total')).toContainText('$78.40');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report ready' })).toBeVisible({ timeout: 60_000 });
  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string }[] };
  type Screen = { diff: boolean; after?: { id?: string; text: string }; lines: string[] };
  const d = (await (await fetch(`${STUDIO}/api/sessions/${sessions[0].id}`)).json()) as { analysis: { timeline: { id: string; text: string }[]; screens?: Screen[] } };
  const screens = d.analysis.screens ?? [];
  // The checkout in full as recording started, then what applying the coupon changed.
  expect(screens[0]?.diff).toBe(false);
  expect(screens[0]?.lines.join('\n')).toContain('$98.00');
  const applied = screens.find((s) => s.diff && s.lines.some((l) => l.startsWith('+ ') && l.includes('78.40')));
  expect(applied, JSON.stringify(screens, null, 1)).toBeTruthy();
  expect(applied!.lines.some((l) => l.startsWith('- ') && l.includes('98.00'))).toBe(true);
  expect(applied!.after?.text).toMatch(/Clicked .*Apply|Submitted .*Coupon/);
  expect(d.analysis.timeline.find((x) => x.id === applied!.after?.id)?.text).toBe(applied!.after?.text);
  // The list says what the report found, not only what the recording showed.
  await page.getByRole('tab', { name: /Sessions/ }).click();
  await expect(page.getByText(/· 0 said · \d+ findings?$/).first()).toBeVisible();
});
