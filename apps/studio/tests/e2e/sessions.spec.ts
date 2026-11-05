/**
 * Test sessions, as a person records one: from the studio, talking in Arabic
 * and then English while using the sample shop, then the report; and from the
 * shop's own tab, across a reload. The microphone plays real recordings
 * (FLEURS); without speech models installed, the narration checks are skipped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import { BROWSER, openStudio, resetAll, SHOP_URL, STUDIO } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEECH = path.resolve(here, '../fixtures/speech');
/** One narration from the recordings: quiet, an Arabic sentence, quiet, an English one, quiet. */
function narration(): string {
  const pcm = (name: string) => fs.readFileSync(path.join(SPEECH, name)).subarray(44);
  const quiet = (s: number) => Buffer.alloc(Math.round(16000 * s) * 2);
  const data = Buffer.concat([quiet(1.5), pcm('ar-fleurs-train.wav'), quiet(1.5), pcm('en-fleurs-smoke.wav'), quiet(8)]);
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
  const file = path.join(os.tmpdir(), 'saywright-e2e-narration.wav');
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

const test = base.extend<{ page: Page }>({
  page: async ({ playwright }, use) => {
    const browser = await playwright.chromium.launch({
      ...BROWSER,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${narration()}%noloop`, '--auto-accept-this-tab-capture'],
    });
    const context = await browser.newContext({ baseURL: STUDIO, viewport: { width: 1440, height: 900 } });
    await use(await context.newPage());
    await browser.close();
  },
});

/** Whether narration in both languages can be transcribed here. */
async function canNarrate(): Promise<boolean> {
  const s = (await (await fetch(`${STUDIO}/api/speech/status`)).json()) as { runtime: string; active: Record<string, string | null> };
  return s.runtime !== 'missing' && s.runtime !== 'failed' && !!s.active.ar && !!s.active.en;
}

async function detail(id: string) {
  return (await (await fetch(`${STUDIO}/api/sessions/${id}`)).json()) as {
    meta: { name: string; startedAt: number; counts: Record<string, number>; audioSeconds: number; video: { parts?: { ms?: number }[] } | null };
    analysis: { steps: { kind: string }[]; issues: { kind: string; title: string }[]; transcript: { lang: string; text: string; el?: { label?: string } }[] };
  };
}

test.beforeEach(() => resetAll());

test('a session in the studio: what you did and said, linked to what you pointed at, and the report', async ({ page }) => {
  test.setTimeout(180_000);
  const narrated = await canNarrate();
  // The narration plays from the moment the microphone opens: no countdown before it (see countdown.spec.ts).
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'auto', mic: true, screen: true, video: true, countdown: 0 })));
  // The panel closed, so the app has the studio's whole width, and nothing of it can be under the panel.
  await openStudio(page, { onboarded: true, theme: 'dark', ui: { panelOpen: false, panelTab: 'changes', device: 'fill', commitOnKeep: false } });
  await page.getByRole('button', { name: 'Record session', exact: true }).click();
  await page.getByRole('radio', { name: 'Both' }).click();
  await page.getByPlaceholder('What are you testing? (optional)').fill('Coupon on checkout');
  await page.getByRole('button', { name: 'Start recording' }).click();
  // Recording once Stop works (the bar says "Starting…" before that).
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();

  // Use the shop, then rest on the total while talking.
  const app = page.frameLocator('iframe');
  // The app laid out at its frame's width, as it is on Linux and in CI. A headless browser on a Mac was seen laying it
  // out as wide as its screen once the tab was shared (the frame itself the right size), so a click aimed at a control
  // lands elsewhere: there that is said, with the widths, and what needs the pointer aimed (the click, what was pointed
  // at) isn't checked. Everything else is, there too.
  const widths = { frame: await page.locator('iframe').evaluate((f) => f.clientWidth), app: await app.locator('body').evaluate(() => innerWidth) };
  const aimable = Math.abs(widths.frame - widths.app) <= 1;
  if (!aimable) test.info().annotations.push({ type: 'browser', description: `While the tab is shared, the app is laid out ${widths.app} px wide in its ${widths.frame} px frame, so the pointer can't be aimed into it: the click and what was pointed at aren't checked.` });
  await app.getByTestId('coupon-input').fill('SAVE20');
  await app.getByTestId('coupon-apply').click();
  await app.getByTestId('summary-total').hover();
  // Under the wave: the voice is heard while it speaks, and each sentence comes back as text.
  await expect(page.locator('[data-voice="speaking"]')).toContainText('Hearing you', { timeout: 20_000 });
  if (narrated) {
    await expect(page.getByText(/\b2 said\b/)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-voice="heard"]')).toContainText('Got it');
  } else await page.waitForTimeout(12_000);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Report ready' }).click({ timeout: 120_000 });
  // Written in the language most of it was said in (here Arabic, once transcribed): read in English.
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.getByText('Findings').first()).toBeVisible();
  await expect(page.getByText('Overall').first()).toBeVisible();

  const id = new URL(page.url()).pathname.split('/').pop()!;
  const d = await detail(id);
  expect(d.meta.name).toBe('Coupon on checkout');
  // Every action, in order, ready to replay as a test.
  expect(d.analysis.steps.map((s) => s.kind)).toEqual(expect.arrayContaining(aimable ? ['fill', 'click'] : ['fill']));
  // Pictures of the screen.
  expect(d.meta.counts.shots).toBeGreaterThan(0);
  expect(d.meta.video?.parts?.[0]?.ms).toBeGreaterThan(1000);

  if (narrated) {
    const ar = d.analysis.transcript.find((s) => s.lang === 'ar');
    const en = d.analysis.transcript.find((s) => s.lang === 'en');
    // “…والعديد من وسائل النقل الأخرى”: a word every Arabic model installed by setup gets right (the default one
    // hears “القطار” as “القطاب”).
    expect(ar?.text).toMatch(/النقل/);
    expect(en?.text).toMatch(/smoke/i);
    // Each sentence knows what was pointed at while it was said.
    if (aimable) expect(ar?.el?.label).toMatch(/Total/);
    await expect(page.getByText(/النقل/).first()).toBeVisible();
  }

  // The report as one page to share.
  const html = await (await fetch(`${STUDIO}/api/sessions/${id}/export.html`)).text();
  expect(html).toContain('<html');
  expect(html).not.toMatch(/<script/i);
});

test('the recorder in the app’s own tab: keeps recording across a reload, and leaves out its own buttons', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('saywright.widget.prefs', JSON.stringify({ lang: 'auto', mic: true, screen: false, countdown: false })));
  await page.goto(`${SHOP_URL}/`);
  const widget = page.locator('saywright-recorder');
  await widget.waitFor({ state: 'attached' });
  await widget.locator('button[data-act="open"]').click();
  await widget.locator('button[data-act="start"]').click();
  // The pill shows at once; Stop works once the session exists.
  await widget.locator('button[data-act="stop"]:not([disabled])').waitFor();
  const id = await page.evaluate(() => JSON.parse(sessionStorage.getItem('saywright.session') ?? 'null')?.id as string);
  expect(id).toBeTruthy();
  // Out of the page's way while it records: a dot that stays (and back with the shortcut), or on the other side.
  await widget.locator('button[data-act="hide"]').click();
  await widget.locator('button[data-act="show"]').waitFor();
  await expect(widget.locator('button[data-act="stop"]')).toHaveCount(0);
  await page.keyboard.press('Alt+Shift+KeyD');
  await widget.locator('button[data-act="stop"]:not([disabled])').waitFor();
  await widget.locator('button[data-act="side"]').click();
  await expect(widget.locator('.root')).toHaveAttribute('data-side', 'left');

  await page.getByTestId('coupon-input').fill('SAVE20');
  await page.getByTestId('coupon-apply').click();
  await page.waitForTimeout(3000);
  await page.reload();
  await widget.locator('button[data-act="stop"]:not([disabled])').waitFor();
  await page.getByTestId('pay-button').click();
  await page.waitForTimeout(3000);
  const recorded = Date.now();
  await widget.locator('button[data-act="stop"]').click();
  await widget.locator('a[data-act="opened"]').waitFor({ timeout: 90_000 });

  const d = await detail(id);
  // Both page loads, every click in the app, and none on the recorder itself.
  expect(d.meta.counts.pages).toBe(2);
  expect(d.meta.counts.clicks).toBe(2);
  // The narration across the reload: nothing lost but the moment the page was reloading.
  expect(d.meta.audioSeconds).toBeGreaterThan(((recorded - d.meta.startedAt) / 1000) * 0.85);
});
