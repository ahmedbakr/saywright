/**
 * Before recording: a countdown in the middle of the screen while the
 * microphone is checked, the speech model loads and the app connects. The
 * session begins only once it is over; Esc lets everything go; a muted or
 * blocked microphone is caught before anything is recorded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { BROWSER, openStudio, resetAll, SHOP_URL, STUDIO } from './helpers';

/** What the microphone hears: a quiet room's hiss (any real microphone sends some), or exact zeros (a muted one). */
function micFile(kind: 'hiss' | 'muted'): string {
  const n = 16000 * 30;
  const data = Buffer.alloc(n * 2);
  let seed = 7;
  if (kind === 'hiss')
    for (let i = 0; i < n; i++) {
      seed = (seed * 16807) % 2147483647;
      data.writeInt16LE(Math.round((seed / 2147483647 - 0.5) * 12), i * 2);
    }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), `saywright-e2e-mic-${kind}.wav`);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

const test = base.extend<{ mic: 'hiss' | 'muted'; page: Page }>({
  mic: ['hiss', { option: true }],
  page: async ({ playwright, mic }, use) => {
    const browser = await playwright.chromium.launch({
      ...BROWSER,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile(mic)}`, '--auto-accept-this-tab-capture'],
    });
    const context = await browser.newContext({ baseURL: STUDIO, viewport: { width: 1440, height: 900 } });
    await use(await context.newPage());
    await browser.close();
  },
});

test.beforeEach(() => resetAll());

const active = async () => ((await (await fetch(`${STUDIO}/api/sessions/active`)).json()) as { session: { id: string; startedAt: number } | null }).session;

async function startFromBar(page: Page, countdown: number): Promise<void> {
  await page.addInitScript((c) => {
    localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: true, screen: false, video: false, countdown: c }));
    // Keep the microphone's streams, to see they are let go.
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const streams: MediaStream[] = [];
    Object.assign(window, { __micStreams: streams });
    navigator.mediaDevices.getUserMedia = async (c2) => {
      const s = await open(c2);
      if (c2?.audio) streams.push(s);
      return s;
    };
  }, countdown);
  await openStudio(page);
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
}

test('counts down in the middle of the screen, checking the microphone, then records', async ({ page }) => {
  test.setTimeout(120_000);
  const clicked = Date.now();
  await startFromBar(page, 3);
  const overlay = page.locator('[data-countdown]');
  await expect(overlay.locator('[data-count="3"]')).toBeVisible();
  // Nothing is recorded during the count, and the bar says when it starts (behind the count, which is modal: the bar is inert meanwhile).
  expect(await active()).toBeNull();
  await expect(page.getByText(/^In \d…/)).toBeVisible();
  await expect(overlay.locator('[data-count="2"]')).toBeVisible();
  await expect(overlay.locator('[data-check="Microphone"]')).toHaveAttribute('data-tone', 'ok');
  await expect(overlay.locator('[data-check="Microphone"]')).toContainText('Working');
  await expect(overlay.locator('[data-check="Your app"]')).toHaveAttribute('data-tone', 'ok');
  await expect(overlay.locator('[data-count="1"]')).toBeVisible();
  // Then recording, once the speech model is ready too (it may still be loading).
  await expect(overlay).toBeHidden({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const session = await active();
  expect(session).toBeTruthy();
  expect(session!.startedAt).toBeGreaterThanOrEqual(clicked + 2500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('Esc cancels the countdown: nothing is recorded, and the microphone is let go', async ({ page }) => {
  await startFromBar(page, 5);
  const overlay = page.locator('[data-countdown]');
  await expect(overlay.locator('[data-check="Microphone"]')).toHaveAttribute('data-tone', 'ok');
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await page.waitForTimeout(800);
  expect(await active()).toBeNull();
  expect(await page.evaluate(() => (window as any).__micStreams.flatMap((s: MediaStream) => s.getTracks()).map((t: MediaStreamTrack) => t.readyState))).toEqual(['ended']);
  await expect(page.getByRole('button', { name: 'Record session', exact: true })).toBeVisible();
});

test('Start now skips the rest of the count', async ({ page }) => {
  await startFromBar(page, 5);
  const overlay = page.locator('[data-countdown]');
  await expect(overlay.locator('[data-count="5"]')).toBeVisible();
  await overlay.getByRole('button', { name: 'Start now' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled({ timeout: 5000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test.describe('a muted microphone', () => {
  test.use({ mic: 'muted' });

  test('is caught before recording: it waits for sound, or starts anyway', async ({ page }) => {
    await startFromBar(page, 3);
    const overlay = page.locator('[data-countdown]');
    await expect(overlay.locator('[data-check="Microphone"]')).toHaveAttribute('data-tone', 'warn', { timeout: 6000 });
    await expect(overlay).toContainText('No sound from the microphone: check it isn’t muted.', { timeout: 10_000 });
    await page.waitForTimeout(1000);
    expect(await active()).toBeNull();
    await overlay.getByRole('button', { name: 'Start anyway' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
  });
});

test('a blocked microphone: say so, and record without voice if wanted', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: true, screen: false, video: false, countdown: 3 })));
  await openStudio(page);
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  const overlay = page.locator('[data-countdown]');
  await expect(overlay.locator('[data-check="Microphone"]')).toHaveAttribute('data-tone', 'bad');
  await expect(overlay).toContainText('The microphone is blocked', { timeout: 10_000 });
  expect(await active()).toBeNull();
  await overlay.getByRole('button', { name: 'Record without voice' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(page.locator('[data-voice="blocked"]')).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('the recorder in the app’s own tab counts down too', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('saywright.widget.prefs', JSON.stringify({ lang: 'en', mic: true, screen: false, countdown: true })));
  await page.goto(`${SHOP_URL}/`);
  const widget = page.locator('saywright-recorder');
  await widget.locator('button[data-act="open"]').click();
  await widget.locator('button[data-act="start"]').click();
  await expect(widget.locator('[data-countdown]')).toBeVisible();
  await expect(widget.locator('.cd-num')).toHaveText(/^[123]$/);
  await expect(widget.locator('.cd-checks [data-tone="ok"]').first()).toContainText('Microphone');
  expect(await active()).toBeNull();
  await widget.locator('button[data-act="go"]').click();
  await widget.locator('button[data-act="stop"]:not([disabled])').waitFor({ timeout: 10_000 });
  expect(await active()).toBeTruthy();
  await widget.locator('button[data-act="stop"]').click();
});
