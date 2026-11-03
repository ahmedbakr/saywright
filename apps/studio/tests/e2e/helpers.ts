/**
 * Shared helpers for the end-to-end tests: a fresh copy of the sample app per
 * test, simulated speech recognition, and a "hand" driven by real MediaPipe
 * landmarks (recorded from photos), fed into the studio at 30 fps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

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
const FIXTURES = JSON.parse(fs.readFileSync(path.resolve(here, '../fixtures/hands.json'), 'utf8'));
/** A real pinch made from the pointing hand (thumb and index from a photo of one; see hands-real.json). */
const POINTING_PINCH: number[][] = JSON.parse(fs.readFileSync(path.resolve(here, '../fixtures/hands-real.json'), 'utf8')).pointingPinches.find((p: { from: string }) => p.from === '249').lm;

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

/**
 * Start feeding hand frames. `setHand` moves the hand or changes its pose;
 * the pump keeps sending frames at 30 fps like a camera would.
 */
export async function startHand(page: Page): Promise<void> {
  await page.evaluate(([fixtures, pointingPinch]) => {
    const w = window as any;
    // Hand control is a Labs feature: a person using it has turned it on.
    w.__saywrightSettings.getState().setLabs({ hand: true });
    w.__saywrightStore.set({ camera: { status: 'on', error: null, fps: 30, delegate: 'GPU' } });
    w.__hand = { pose: null, x: 0, y: 0, pinch: 0, raw: null };
    const frame = () => {
      const h = w.__hand;
      if (!h.pose) return { t: performance.now(), hands: [], aspect: 4 / 3 };
      const f = fixtures[h.pose];
      const lm = f.hands[0].lm.map(([x, y, z]: number[]) => ({ x, y, z }));
      const box = w.__saywrightSettings.getState().engine.box;
      // `raw` places the fingertip in camera coordinates (for calibration); otherwise aim at a screen point.
      const camX = h.raw ? h.raw.x : 1 - (box.x0 + (h.x / innerWidth) * (box.x1 - box.x0));
      const camY = h.raw ? h.raw.y : box.y0 + (h.y / innerHeight) * (box.y1 - box.y0);
      const dx = camX - lm[8].x;
      const dy = camY - lm[8].y;
      const pts = lm.map((p: { x: number; y: number; z: number }) => ({ x: p.x + dx, y: p.y + dy, z: p.z }));
      if (h.pinch && h.pose === 'pointing_up') {
        // As a real hand pinches: the index bends down onto the thumb (its tip moves), the thumb comes up.
        for (const i of [1, 2, 3, 4, 6, 7, 8]) {
          const [px, py, pz] = pointingPinch[i];
          pts[i] = { x: pts[i].x + (px - lm[i].x) * h.pinch, y: pts[i].y + (py - lm[i].y) * h.pinch, z: pts[i].z + (pz - lm[i].z) * h.pinch };
        }
      } else if (h.pinch) {
        const t = pts[4];
        const i = pts[8];
        pts[4] = { x: t.x + (i.x + 0.004 - t.x) * h.pinch, y: t.y + (i.y + 0.006 - t.y) * h.pinch, z: t.z + (i.z - t.z) * h.pinch };
        pts[3] = { x: (pts[2].x + pts[4].x) / 2, y: (pts[2].y + pts[4].y) / 2, z: pts[4].z };
      }
      return { t: performance.now(), hands: [{ landmarks: pts, handedness: f.hands[0].handedness, score: 0.99 }], aspect: f.w / f.h };
    };
    clearInterval(w.__pump);
    w.__pump = setInterval(() => w.__saywright.onFrame(frame()), 33);
  }, [FIXTURES, POINTING_PINCH] as const);
}

export async function setHand(page: Page, hand: { pose?: string | null; x?: number; y?: number; pinch?: number; raw?: { x: number; y: number } | null }): Promise<void> {
  await page.evaluate((h) => Object.assign((window as any).__hand, h), hand);
}

/** Pinch and release at the current position, the way a hand does it (the fingers close and open over ~150 ms): a tap. */
export async function pinchTap(page: Page): Promise<void> {
  for (const k of [0.35, 0.7, 1]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(150);
  for (const k of [0.6, 0.25, 0]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(200);
}

/** Pinch and keep the fingers together for `ms` before letting go: a hold. */
export async function pinchHold(page: Page, ms = 1000): Promise<void> {
  for (const k of [0.35, 0.7, 1]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(ms);
  for (const k of [0.6, 0.25, 0]) {
    await setHand(page, { pinch: k });
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(200);
}

/** The labels of everything selected, in the order picked. */
export const selectedLabels = (page: Page): Promise<string[]> => store<string[]>(page, '(s.pins.length ? s.pins : s.selection ? [s.selection] : []).map((e) => e.label)');

async function islandText(page: Page): Promise<string> {
  return (await page.locator('[data-island]').innerText()).replace(/\s+/g, ' ');
}

export async function expectIsland(page: Page, re: RegExp): Promise<void> {
  await expect.poll(() => islandText(page), { timeout: 15_000 }).toMatch(re);
}
