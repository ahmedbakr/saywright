/**
 * Voice with real audio: Chrome's fake microphone plays a recording (each
 * starts with 1.2 s of quiet, then the words, then quiet), and the on-device
 * model transcribes it. The browser recogniser is simulated where it is used.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import { appPoint, BROWSER, expectIsland, openStudio, resetAll, store, STUDIO } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Each test gets a browser whose microphone plays `recording` once. */
const test = base.extend<{ recording: string; page: Page }>({
  recording: ['e2e-make-this-bigger.wav', { option: true }],
  page: async ({ playwright, recording }, use) => {
    const file = path.resolve(here, '../fixtures/speech', recording);
    const browser = await playwright.chromium.launch({
      ...BROWSER,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}%noloop`],
    });
    const context = await browser.newContext({ baseURL: STUDIO, viewport: { width: 1440, height: 900 } });
    await use(await context.newPage());
    await browser.close();
  },
});

async function modelReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__saywright.voice.asr.state === 'ready', null, { timeout: 60_000 });
}

/** Hold Space while the recording plays. */
async function talk(page: Page, holdMs: number, during?: () => Promise<void>): Promise<void> {
  await page.keyboard.down('Space');
  await expect.poll(() => store<string>(page, 's.voice.state')).toBe('listening');
  await during?.();
  await page.waitForTimeout(holdMs);
  await page.keyboard.up('Space');
  await expect.poll(() => store<string>(page, 's.voice.state'), { timeout: 15_000 }).toBe('idle');
}

test.beforeEach(() => resetAll());

test.describe('“make this bigger”, recorded', () => {
  test('is understood on this computer alone, and applied to what you point at', async ({ page }) => {
    await openStudio(page, { onboarded: true, theme: 'dark', voice: { engine: 'device' } });
    await modelReady(page);
    const apply = await appPoint(page, 'coupon-apply');
    await page.mouse.move(apply.x, apply.y);
    await expect.poll(() => store<string>(page, 's.hover?.label')).toContain('Apply');
    await talk(page, 3300);
    // Heard on this computer (directly, or corrected from a sound-alike such as “beggar”); no browser recogniser involved.
    expect(['device', 'variant']).toContain(await store<string>(page, 's.voice.last.source'));
    expect(await store<string[]>(page, 's.voice.last.browser')).toEqual([]);
    expect(await store<string>(page, 's.voice.last.text')).toBe('Make this bigger.');
    await expectIsland(page, /Apply.*size sm → md/);
    await expect(page.locator('[data-island="preview"]')).toContainText('“Make this bigger.”');
  });

  test('keeps the first word when the browser recogniser starts late', async ({ page }) => {
    await openStudio(page, { onboarded: true, theme: 'dark', voice: { engine: 'auto' } });
    await modelReady(page);
    const apply = await appPoint(page, 'coupon-apply');
    await page.mouse.move(apply.x, apply.y);
    await expect.poll(() => store<string>(page, 's.hover?.label')).toContain('Apply');
    // The simulated browser recogniser only catches the end of the sentence.
    await talk(page, 3300, () => page.evaluate(() => void (window as any).__speech.say('this bigger')));
    expect(await store<string[]>(page, 's.voice.last.browser')).toEqual(['this bigger']);
    expect(await store<string>(page, 's.voice.last.text')).toBe('Make this bigger.');
    await expectIsland(page, /Apply.*size sm → md/);
  });

  test('hands-free: a quick tap listens until you pause', async ({ page }) => {
    await openStudio(page, { onboarded: true, theme: 'dark', voice: { engine: 'device', autoStopMs: 1000 } });
    await modelReady(page);
    const apply = await appPoint(page, 'coupon-apply');
    await page.mouse.move(apply.x, apply.y);
    await expect.poll(() => store<string>(page, 's.hover?.label')).toContain('Apply');
    await page.keyboard.press('Space');
    await expect.poll(() => store<string>(page, 's.voice.trigger')).toBe('toggle');
    // It stops by itself about a second after the words end, with nothing pressed.
    await expect.poll(() => store<string>(page, 's.voice.last?.text'), { timeout: 15_000 }).toBe('Make this bigger.');
    await expectIsland(page, /Apply.*size sm → md/);
  });

  test('can be checked in the command bar before sending', async ({ page }) => {
    await openStudio(page, { onboarded: true, theme: 'dark', voice: { engine: 'device', review: true } });
    await modelReady(page);
    await talk(page, 3300);
    const input = page.getByRole('textbox', { name: 'Describe a change' });
    await expect(input).toHaveValue('Make this bigger.');
    await expect(input).toBeFocused();
    // Nothing was sent yet.
    expect(await store<number>(page, 's.history.length')).toBe(0);
    await input.fill('Make this smaller.');
    await page.keyboard.press('Enter');
    await expect.poll(() => store<string>(page, 's.history[0]')).toBe('Make this smaller.');
    await expect(input).toHaveValue('');
  });
});

test.describe('“undo”, recorded', () => {
  test.use({ recording: 'e2e-undo.wav' });

  test('a short command the model can’t transcribe is still recognised', async ({ page }) => {
    await openStudio(page, { onboarded: true, theme: 'dark', voice: { engine: 'device' } });
    await modelReady(page);
    await talk(page, 2600);
    expect(await store<string>(page, 's.voice.last.text')).toBe('Undo.');
    // Nothing waits to be undone: it says so, or offers the last change kept (an earlier test's, if one was).
    await expectIsland(page, /Nothing to undo|Nothing is waiting\. Undo the last change you kept/);
  });
});

test.describe('the voice test in Settings', () => {
  test('shows what was heard without acting on it', async ({ page }) => {
    await openStudio(page, { onboarded: true, theme: 'dark', voice: { engine: 'device' } });
    await modelReady(page);
    await page.evaluate(() => (window as any).__saywrightStore.set({ overlay: 'settings', settingsTab: 'voice' }));
    const button = page.getByRole('button', { name: 'Hold to talk' });
    // Below the fold when the speech models' list is long.
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(3300);
    await page.mouse.up();
    const panel = page.locator('[data-voice-test]');
    await expect(panel).toContainText('“Make this bigger.”', { timeout: 15_000 });
    await expect(panel).toContainText('On-device heard');
    expect(await store<number>(page, 's.history.length')).toBe(0);
  });
});
