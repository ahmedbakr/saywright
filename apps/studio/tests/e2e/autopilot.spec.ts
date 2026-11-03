/**
 * Autopilot on the sample shop, with the test double for the AI (it knows this shop): it reads the checkout, applies
 * SAVE20, sees the discount taken from shipping too, and the run ends in the session's report, with its steps in the
 * timeline and the problem among the findings, tied to the coupon's code.
 */
import { expect, test } from '@playwright/test';
import { openStudio, resetAll, store, STUDIO, waitForApp } from './helpers';

test.beforeEach(() => resetAll());

async function detail(id: string) {
  return (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as {
    meta: { name: string; source: string; status: string };
    analysis: { issues: { kind: string; title: string; severity: string; detail: string; src?: string }[]; timeline: { kind: string; text: string; detail?: string }[]; steps: { kind: string; locator?: string }[] };
    report: { findings: { title: string; location: string }[] } | null;
  };
}

test('Autopilot uses the app like a tester and ends in a report of what it found', async ({ page }) => {
  await openStudio(page);
  await waitForApp(page);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  const card = page.locator('[data-autopilot-card]');
  await card.locator('[data-autopilot-goal]').fill('Apply the SAVE20 coupon at checkout');
  // Without permission, it leaves deleting, paying and sending alone.
  await expect(card.getByRole('switch', { name: 'Let it delete, pay, send and sign out' })).not.toBeChecked();
  await card.locator('[data-autopilot-start]').click();

  // It shows what it is doing, step by step, with a way out.
  await expect(page.locator('[data-autopilot]')).toBeVisible();
  await expect(page.locator('[data-autopilot-step]')).toContainText(/Put a product in the cart|Go to the checkout|Try the SAVE20 coupon|Apply it/, { timeout: 20_000 });
  await expect(page.locator('[data-autopilot-stop]')).toBeVisible();

  // The run ends in the session's report, which opens by itself.
  await expect(page.locator('[data-autopilot]')).toHaveCount(0, { timeout: 60_000 });
  const report = page.getByRole('dialog', { name: 'Session report' });
  await expect(report.getByText('SAVE20 takes 20% off shipping too').first()).toBeVisible({ timeout: 120_000 });

  const { sessions } = (await (await fetch(`${STUDIO}/api/sessions`)).json()) as { sessions: { id: string; source: string }[] };
  const d = await detail(sessions.find((s) => s.source === 'autopilot')!.id);
  expect(d.meta.source).toBe('autopilot');
  expect(d.meta.name).toBe('Autopilot: Apply the SAVE20 coupon at checkout');
  // What it did, in the timeline, in order, and as steps a replay or a test can take again.
  const did = d.analysis.timeline.filter((x) => x.text.startsWith('Autopilot: ')).map((x) => x.text);
  expect(did).toEqual(['Autopilot: Typed “SAVE20” into “Coupon”', 'Autopilot: Clicked “Apply”']);
  expect(d.analysis.steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['click', 'fill']));
  // What it saw, as a finding with what it expected, tied to the coupon's code.
  const seen = d.analysis.issues.find((g) => g.kind === 'observed');
  expect(seen).toMatchObject({ title: 'SAVE20 takes 20% off shipping too', severity: 'high' });
  expect(seen?.detail).toContain('Expected: A discount of 20% of the items only');
  expect(seen?.src).toMatch(/CouponField\.tsx:\d+:\d+$/);
  // The app is where the run left it: back in Edit mode, with the coupon applied in the shop.
  expect(await store<string>(page, 's.mode')).not.toBe('use');
  await expect(page.frameLocator('iframe').getByText('SAVE20 applied')).toBeVisible();
});

test('Escape stops a run, which still ends in its report', async ({ page }) => {
  await openStudio(page);
  await waitForApp(page);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await page.locator('[data-autopilot-start]').click();
  await expect(page.locator('[data-autopilot]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-autopilot]')).toHaveCount(0, { timeout: 30_000 });
  // A stopped run still ends in its report.
  await expect(page.getByRole('dialog', { name: 'Session report' })).toBeVisible({ timeout: 120_000 });
});
