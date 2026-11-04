/**
 * Write test, made safe: a password typed while writing a test never leaves the app (not in the steps, the test
 * file, what the AI is sent, or the studio's data in the app's folder), and the test types it from a secret saved
 * on this computer; a choice in a list is chosen, not typed, also several at once; a run that never reached its
 * checks says it doesn't show the bug; and a fix that only weakens the test is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_SHOP, appPoint, expectIsland, openStudio, resetAll, store, STUDIO } from './helpers';

test.beforeEach(() => resetAll());

const PASSWORD = 'tidewell-2026';

/** Every file under a folder, as text (node_modules and .git left out). */
function grepTree(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size < 5_000_000 && fs.readFileSync(p, 'utf8').includes(needle)) hits.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}

/** Where a secret could leak to in the app's folder: the studio's data there (sessions, changes, metrics) and its tests. The sample's own code knows its password. */
const leaks = (needle: string) => [...grepTree(path.join(E2E_SHOP, '.saywright'), needle), ...grepTree(path.join(E2E_SHOP, 'tests'), needle)];

async function openAccount(page: Page): Promise<void> {
  await openStudio(page);
  await page.frameLocator('iframe').locator('body').evaluate(() => (location.hash = '#/account'));
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Your account' })).toBeVisible();
}

async function check(page: Page, testId: string, words: string): Promise<void> {
  const at = await appPoint(page, testId, 0.5);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: 'Describe a change' }).fill(words);
  await page.keyboard.press('Enter');
  await expectIsland(page, /Check added/);
}

test('a password typed while writing a test never leaves the app, and the test types it from a saved secret', async ({ page }) => {
  test.setTimeout(180_000);
  await openAccount(page);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  const app = page.frameLocator('iframe');
  await app.getByLabel('Email').fill('me@example.com');
  await app.getByLabel('Password', { exact: true }).fill(PASSWORD);
  // “Show password” makes it a text field: it is still a password.
  await app.getByLabel('Show password').check();
  await app.getByRole('button', { name: 'Sign in' }).click();
  await expect(app.getByTestId('signed-in')).toContainText('Signed in as me@example.com');
  await expect.poll(() => store<number>(page, 's.recorder.steps.filter((x) => x.secret === "PASSWORD").length')).toBe(1);
  const steps = await store<unknown[]>(page, 's.recorder.steps');
  expect(JSON.stringify(steps)).not.toContain(PASSWORD);

  // Hovering the field shows nothing of it either.
  const field = await appPoint(page, 'signed-in', 0.5);
  await page.mouse.move(field.x, field.y);
  await check(page, 'signed-in', 'this should show Signed in as me@example.com');
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const specPath = await store<string>(page, 's.recorder.spec.path');
  const spec = fs.readFileSync(path.join(E2E_SHOP, specPath), 'utf8');
  expect(spec).not.toContain(PASSWORD);
  // Found as Playwright finds it: by its exact label (“Password” alone would find “Show password” too).
  expect(spec).toContain("await page.getByLabel('Password', { exact: true }).fill(secret('PASSWORD'));");

  // Without the secret, the test doesn't run with an empty password: it asks for it.
  await page.getByRole('button', { name: 'Run it' }).click();
  await expectIsland(page, /This test types PASSWORD/);
  await page.getByRole('button', { name: 'Open the Test tab' }).click();
  const secrets = page.locator('div', { has: page.getByText('PASSWORD', { exact: true }) }).filter({ hasText: 'Not set' }).last();
  await secrets.getByRole('button', { name: 'Set' }).click();
  await page.getByLabel('Value of PASSWORD').fill(PASSWORD);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // With it, the test signs in, every step and the check ran: verified.
  await page.getByRole('button', { name: 'Run test' }).first().click();
  await expectIsland(page, /Test passed in [\d.]+ s: all \d+ steps and 1 check ran/);
  expect(await store<boolean>(page, 's.recorder.run.verified')).toBe(true);

  // The password is nowhere in the app's folder: not in the test, nor in the studio's data there.
  expect(leaks(PASSWORD)).toEqual([]);
  // The secret is saved with the studio's data, readable by you alone.
  const { saved } = (await (await fetch(`${STUDIO}/api/tests/secrets`)).json()) as { saved: string[] };
  expect(saved).toContain('PASSWORD');
});

test('a choice in a list is chosen with selectOption, several in a multi-select, and the test runs', async ({ page }) => {
  test.setTimeout(150_000);
  await openAccount(page);
  await page.keyboard.press('r');
  await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
  const app = page.frameLocator('iframe');
  await app.getByLabel('Delivery').selectOption('express');
  await app.getByLabel('Interests').selectOption(['Ceramics', 'Linen']);
  await app.getByRole('button', { name: 'Save preferences' }).click();
  await expect(app.getByTestId('preferences-saved')).toContainText('Saved: Express · Ceramics, Linen');
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBeGreaterThanOrEqual(3);
  await check(page, 'preferences-saved', 'this should show Saved: Express · Ceramics, Linen');
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const spec = fs.readFileSync(path.join(E2E_SHOP, await store<string>(page, 's.recorder.spec.path')), 'utf8');
  expect(spec).toContain("await page.getByRole('combobox', { name: 'Delivery' }).selectOption({ label: 'Express' });");
  expect(spec).toContain("await page.getByRole('listbox', { name: 'Interests' }).selectOption([{ label: 'Ceramics' }, { label: 'Linen' }]);");
  expect(spec).not.toMatch(/\.fill\(/);
  await page.getByRole('button', { name: 'Run it' }).click();
  await expectIsland(page, /Test passed in [\d.]+ s: all \d+ steps and 1 check ran/);
});

test('a test that never reaches its check says it doesn’t show the bug yet, and a fix that only weakens the test is refused', async ({ page }) => {
  test.setTimeout(180_000);
  await openStudio(page);
  await page.keyboard.press('r');
  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect.poll(() => store<number>(page, 's.recorder.steps.length')).toBe(2);
  await check(page, 'summary-total', 'this should show $80.80');
  await page.getByRole('button', { name: 'Generate test' }).first().click();
  await expectIsland(page, /Test saved to tests\/saywright\//);
  const rel = await store<string>(page, 's.recorder.spec.path');
  const file = path.join(E2E_SHOP, rel);
  const good = fs.readFileSync(file, 'utf8');

  // A step that can't be done (its field is gone): the run stops before the check, and says so.
  fs.writeFileSync(file, good.replace("getByTestId('coupon-input')", "getByTestId('coupon-input-gone')"));
  await page.getByRole('button', { name: 'Run it' }).click();
  // The step waits for its field as long as a slow app would need (15 s) before it gives up.
  await expect.poll(() => store<string | undefined>(page, 's.recorder.run && s.recorder.run.failedAt'), { timeout: 60_000 }).toBe('step');
  await expectIsland(page, /didn’t reach its checks, so it doesn’t show the bug yet/);
  expect(await store<string>(page, 's.recorder.run.failedAt')).toBe('step');

  // The real test fails at its check: the bug shows. A “fix” that only loosens the check is refused, the test untouched.
  fs.writeFileSync(file, good);
  await page.getByRole('button', { name: 'Run test' }).first().click();
  await expectIsland(page, /Test failed: expected “\$80\.80”, got “\$78\.40”/);
  const res = await page.evaluate(async (path) => {
    const r = await fetch('/api/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, failure: 'expected $80.80', text: 'fix it, change the test' }) });
    return (await r.json()) as { kind: string; text?: string };
  }, rel);
  expect(res.kind).toBe('message');
  expect(res.text).toMatch(/only changed the test, not your app/);
  expect(fs.readFileSync(file, 'utf8')).toBe(good);
});

test('a session never records a typed password or key; its steps name the secret, and no file of it holds one', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
  await openAccount(page);
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Sign in');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const app = page.frameLocator('iframe');
  await app.getByLabel('Email').fill('me@example.com');
  await app.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await app.getByLabel('API key').fill('sk-live-abcdefghijklmnop1234');
  // The screen it records shows them as dots: its screenshots and video are pictures of the screen.
  const shown = (label: string) => app.getByLabel(label, { exact: true }).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-text-security'));
  await expect.poll(() => shown('API key')).toBe('disc');
  await expect.poll(() => shown('Password')).toBe('disc');
  expect(await shown('Email')).not.toBe('disc');
  await app.getByRole('button', { name: 'Sign in' }).click();
  await expect(app.getByTestId('signed-in')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  // Once the session stops, the app looks as it did.
  await expect.poll(() => shown('API key')).not.toBe('disc');
  await page.getByRole('button', { name: 'Report ready' }).click({ timeout: 120_000 });
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const res = await fetch(`${STUDIO}/api/sessions/${id}`);
  const text = await res.text();
  const detail = JSON.parse(text) as { analysis: { steps: { secret?: string; value?: string }[] } };
  expect(detail.analysis.steps.some((s) => s.secret === 'PASSWORD' && !s.value)).toBe(true);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain('sk-live-abcdefghijklmnop1234');
  // Nor in the session's own files (events, report, exports), kept in the app's folder.
  expect(leaks(PASSWORD)).toEqual([]);
  expect(leaks('sk-live-abcdefghijklmnop1234')).toEqual([]);
});
