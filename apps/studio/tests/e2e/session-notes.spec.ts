/**
 * A tester without a microphone still says what they noticed: Mark (the button, or M) takes a typed note. The mark
 * is made at the moment it was asked for, whatever time the typing takes, and the report gives the note as the
 * tester's words.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_SHOP, openStudio, resetAll } from './helpers';

test.beforeEach(() => resetAll());

test('a mark takes a typed note: Enter saves it, leaving the field keeps it, Esc keeps the mark alone', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
  await openStudio(page, { onboarded: true, theme: 'light' });
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Notes without a microphone');
  await page.getByRole('button', { name: 'Start recording' }).click();
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeEnabled();
  // With no microphone, the bar says how to leave a note.
  await expect(page.getByText('Press M to note what you notice.')).toBeVisible();

  const app = page.frameLocator('iframe');
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await expect(app.getByTestId('summary-total')).toContainText('$78.40');

  // The button: the note field takes the keyboard, and the moment is the click's, not the Enter's.
  const marked = Date.now();
  await page.getByRole('button', { name: 'Mark', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'What did you notice?' });
  await expect(note).toBeFocused();
  await page.waitForTimeout(1500);
  // Typing an m in a note is a letter, not another mark.
  await note.pressSequentially('The total must be $80.80: shipping is not discounted', { delay: 5 });
  await note.press('Enter');
  await expect(note).toHaveCount(0);

  // The key, then a click back into the app: the note is kept with what it says so far.
  await page.locator('body').press('m');
  await expect(note).toBeFocused();
  await note.fill('Pay still shows the old amount');
  await app.getByTestId('pay-button').hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect(note).toHaveCount(0);

  // From inside the app (the keyboard is there after the click), its own shortcut; Esc: a mark, with no words.
  await page.keyboard.press('Alt+Shift+M');
  await expect(note).toBeFocused();
  await note.fill('never mind');
  await note.press('Escape');
  await expect(note).toHaveCount(0);
  // Still recording: Esc in the note didn't stop anything.
  await expect(stop).toBeEnabled();

  await stop.click();
  await page.getByRole('button', { name: 'Report ready' }).click({ timeout: 120_000 });
  const report = page.getByRole('dialog', { name: 'Session report' });
  await expect(report.getByText('Marked: The total must be $80.80: shipping is not discounted').first()).toBeVisible();
  await expect(report.getByText('Marked: Pay still shows the old amount').first()).toBeVisible();

  // As stored: three marks, each at the moment it was asked for.
  const sessions = path.join(E2E_SHOP, '.saywright/sessions');
  const id = fs.readdirSync(sessions).sort().pop()!;
  const marks = fs
    .readFileSync(path.join(sessions, id, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; note?: string; t: number })
    .filter((e) => e.type === 'mark')
    .sort((a, b) => a.t - b.t);
  expect(marks.map((m) => m.note)).toEqual(['The total must be $80.80: shipping is not discounted', 'Pay still shows the old amount', '']);
  // Not when its note was finished, more than a second and a half later.
  expect(marks[0].t - marked).toBeLessThan(1200);
});
