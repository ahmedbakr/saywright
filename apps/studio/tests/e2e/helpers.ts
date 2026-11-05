/**
 * Shared helpers for the end-to-end tests: a fresh copy of the sample app per
 * test, and simulated speech recognition.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { keepUndoHint } from '../../src/core/keys';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHOP = path.resolve(here, '../../../shop');
/** Where the e2e studio and its copy of the shop run (E2E_STUDIO_PORT / E2E_SHOP_PORT move them, to run suites side by side). */
export const STUDIO = `http://localhost:${process.env.E2E_STUDIO_PORT || 5273}`;
export const SHOP_URL = `http://localhost:${process.env.E2E_SHOP_PORT || 5274}`;
export const E2E_SHOP = path.resolve(here, '../.e2e-shop');
/**
 * The browser a test launches itself: the Chromium PW_CHROMIUM_PATH names, else Playwright's full Chromium (its
 * `chromium` channel) rather than its headless shell, whose microphone, camera and screen sharing differ from Chrome's.
 */
export const BROWSER = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : { channel: 'chromium' };

/** Settle anything a previous test left pending (changes, a session still recording), then put the sample app's sources back. */
export async function resetAll(): Promise<void> {
  await fetch(`${STUDIO}/api/changes/keep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"via":"test"}' }).catch(() => undefined);
  const { session } = (await (await fetch(`${STUDIO}/api/sessions/active`)).json().catch(() => ({}))) as { session?: { id: string } | null };
  if (session) await fetch(`${STUDIO}/api/sessions/${session.id}/stop`, { method: 'POST', body: '{}' }).catch(() => undefined);
  // Give the dev server a moment to notice restored files, or the next page could load the old code.
  if (resetShop()) await new Promise((r) => setTimeout(r, 600));
}

/** Put the sample app's sources back to their original state. Returns whether any file changed. */
function resetShop(): boolean {
  let changed = false;
  const restore = (from: string, to: string) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(b, { recursive: true });
        restore(a, b);
      } else if (!fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) {
        fs.copyFileSync(a, b);
        changed = true;
      }
    }
  };
  restore(path.join(SHOP, 'src'), path.join(E2E_SHOP, 'src'));
  // The page's head (a review's fix can change it).
  const html = fs.readFileSync(path.join(SHOP, 'index.html'));
  if (!html.equals(fs.readFileSync(path.join(E2E_SHOP, 'index.html')))) {
    fs.writeFileSync(path.join(E2E_SHOP, 'index.html'), html);
    changed = true;
  }
  fs.rmSync(path.join(E2E_SHOP, 'tests/saywright'), { recursive: true, force: true });
  return changed;
}

export function shopFile(rel: string): string {
  return fs.readFileSync(path.join(E2E_SHOP, rel), 'utf8');
}

/** A computer where the quick-start tour hasn't been taken yet (the studio server remembers it for every browser). */
export async function forgetTour(): Promise<void> {
  await fetch(`${STUDIO}/api/tour`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"seen":false}' });
}

/**
 * Open the studio with settings pre-seeded (`onboarded` skips the quick-start tour).
 * Speech comes from the simulated browser recogniser (`__speech.say`) unless
 * the settings pick another engine.
 */
export async function openStudio(page: Page, settings: Record<string, unknown> = { onboarded: true, theme: 'dark' }): Promise<void> {
  const seeded = { ...settings, voice: { engine: 'browser', ...(settings.voice as object) } };
  await page.addInitScript((s) => {
    localStorage.setItem('saywright.settings', JSON.stringify({ state: s, version: 1 }));
    installFakeSpeech();
    function installFakeSpeech() {
      type Handler = ((e: unknown) => void) | null;
      class FakeRecognition {
        lang = 'en-US';
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onresult: Handler = null;
        onerror: Handler = null;
        onend: (() => void) | null = null;
        onstart: (() => void) | null = null;
        onaudiostart: (() => void) | null = null;
        constructor() {
          (window as unknown as { __speech: { current: unknown } }).__speech.current = this;
        }
        start() {
          setTimeout(() => {
            this.onstart?.();
            this.onaudiostart?.();
          }, 0);
        }
        stop() {
          setTimeout(() => this.onend?.(), 40);
        }
        abort() {
          setTimeout(() => this.onend?.(), 0);
        }
      }
      const speech = {
        current: null as FakeRecognition | null,
        /** Speak `text` word by word (interim results), then deliver it as final. */
        async say(text: string, gap = 140) {
          const words = text.split(' ');
          const emit = (transcript: string, isFinal: boolean) =>
            speech.current?.onresult?.({ resultIndex: 0, results: [{ 0: { transcript }, isFinal, length: 1 }] });
          for (let i = 1; i <= words.length; i++) {
            emit(words.slice(0, i).join(' '), false);
            await new Promise((r) => setTimeout(r, gap));
          }
          emit(text, true);
        },
      };
      Object.assign(window, { __speech: speech, SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeRecognition });
    }
  }, seeded);
  await page.goto('/');
  await waitForApp(page);
}

export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__saywrightStore?.get().app.connected, null, { timeout: 30_000 });
}

export const store = <T>(page: Page, pick: string): Promise<T> => page.evaluate((p) => new Function('s', `return ${p}`)((window as any).__saywrightStore.get()), pick);

/** Centre of an element inside the app iframe, in page coordinates. */
export async function appPoint(page: Page, testId: string, fx = 0.5, fy = 0.5): Promise<{ x: number; y: number }> {
  const b = await page.frameLocator('iframe').getByTestId(testId).boundingBox();
  if (!b) throw new Error(`no box for ${testId}`);
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

/** The labels of everything selected, in the order picked. */
export const selectedLabels = (page: Page): Promise<string[]> => store<string[]>(page, '(s.pins.length ? s.pins : s.selection ? [s.selection] : []).map((e) => e.label)');

async function islandText(page: Page): Promise<string> {
  return (await page.locator('[data-island]').innerText()).replace(/\s+/g, ' ');
}

/**
 * The keys as the studio names them on the computer its browser runs on: Return and ⌘Z on a Mac, Enter and Ctrl Z
 * elsewhere. A test of what the studio says reads them here, so it holds on every computer.
 */
export async function keyNames(page: Page): Promise<{ enter: string; undo: string; palette: string; keepUndo: string }> {
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  return { enter: mac ? 'Return' : 'Enter', undo: mac ? '⌘Z' : 'Ctrl Z', palette: mac ? '⌘K' : 'Ctrl K', keepUndo: keepUndoHint(mac) };
}

/** Text as a pattern that matches it exactly. */
export const literally = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function expectIsland(page: Page, re: RegExp): Promise<void> {
  await expect.poll(() => islandText(page), { timeout: 15_000 }).toMatch(re);
}

/**
 * Start a run of the test being written and wait until it is over: a run starts Playwright and a browser, which on a
 * busy machine takes longer than what it then says is waited for.
 */
export async function runToEnd(page: Page, start: () => Promise<unknown>): Promise<void> {
  const since = (await store<number | null>(page, 's.recorder.run ? s.recorder.run.at : null')) ?? 0;
  await start();
  await expect.poll(() => store<boolean>(page, `!s.recorder.running && !!s.recorder.run && s.recorder.run.at > ${since}`), { timeout: 120_000, intervals: [500] }).toBe(true);
}
