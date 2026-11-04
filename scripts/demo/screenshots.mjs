#!/usr/bin/env node
/**
 * Takes the screenshots in the documentation: the studio's main screens on the sample shop, into docs/media/guide/.
 *
 *   npm run media:screenshots
 *   node scripts/demo/screenshots.mjs --only inspect,preview      just these
 *
 * Two passes, each with its own studio and a fresh copy of the sample shop (see stage.mjs):
 *
 *   first run   no AI connected, as a newcomer meets the studio: the welcome, the tour, your apps, linking an app,
 *               Settings, the command palette, the shortcuts
 *   with an AI  the screen explained, pointing, a preview and its diff, an answer, Write test, a recorded session,
 *               its report, Replay & verify, the Experts, the sessions, usage
 *
 * The AI is the studio's test stand-in unless DEMO_AI=real is set with ANTHROPIC_API_KEY: then the real Claude
 * answers, for a few cents of API use. Settings → AI is only taken in the first pass, so no key is ever on screen.
 * The settings of record.mjs apply (DEMO_STUDIO_PORT, DEMO_SHOP_PORT, PW_CHROMIUM_PATH, FFMPEG).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { ROOT, STUDIO_DIR } from '../lib/paths.mjs';
import { H, REAL, STUDIO, W, WORK, api, checkFfmpeg, frame, log, openStudio, prepareStudio, screenshot, serve, sleep } from './stage.mjs';

const DIR = 'guide';
const PASSES = ['first', 'ai'];

// ───────────────────────────── helpers ─────────────────────────────

const shot = (page, name, clip) => screenshot(page, `${DIR}/${name}.png`, { clip });
const island = (page, kind) => page.locator(`[data-island="${kind}"]`);
/** Out of the way, so no hover state shows. */
const park = async (page) => {
  await page.mouse.move(W - 6, H - 6);
  await page.waitForTimeout(350);
};

/** The smallest box around what `locators` show, `pad` pixels wider on each side, inside the page. */
async function around(locators, pad = 24) {
  const boxes = [];
  for (const l of locators) {
    const b = await l.boundingBox();
    if (b) boxes.push(b);
  }
  if (!boxes.length) return undefined;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(W, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(H, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
}

/** The side panel and the top bar above it: what a panel tab shows, with where it is. */
const panel = (page) => around([page.locator('aside[aria-hidden="false"]'), page.locator('[data-tour="ai"]')], 0).then((b) => b && { ...b, x: Math.max(0, b.x - 320), width: Math.min(W, b.width + 320) });

/** Clicks the middle of something in the app, as a person's pointer would (the studio sees the pointer, not the app). */
async function clickInApp(page, testId, modifiers) {
  const b = await frame(page).getByTestId(testId).boundingBox();
  if (!b) throw new Error(`No ${testId} in the app`);
  for (const m of modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  for (const m of modifiers ?? []) await page.keyboard.up(m);
}

async function hoverInApp(page, testId, fx = 0.5) {
  const b = await frame(page).getByTestId(testId).boundingBox();
  await page.mouse.move(b.x + b.width * fx, b.y + b.height / 2);
  await page.waitForTimeout(700);
}

async function say(page, text) {
  await page.getByRole('textbox', { name: 'Describe a change' }).fill(text);
  await page.keyboard.press('Enter');
}

/**
 * What the tester says while pointing, from a recording (“This should show eighty dollars eighty”), sent to the
 * session as the microphone sends it. Returns how long it lasts, in milliseconds.
 */
async function narrate(sessionId) {
  const pcm = fs.readFileSync(path.join(STUDIO_DIR, 'tests', 'fixtures', 'speech', 'expect.wav')).subarray(44);
  const quiet = Buffer.alloc(16000 * 2);
  const audio = Buffer.concat([quiet, pcm, quiet]);
  const t = Date.now();
  // 16 kHz, 16-bit mono: 32 bytes a millisecond, sent half a second at a time.
  for (let at = 0; at < audio.length; at += 16000) {
    await fetch(`${STUDIO}/api/sessions/${sessionId}/audio?t=${t + at / 32}`, { method: 'POST', body: audio.subarray(at, at + 16000), headers: { 'Content-Type': 'text/plain' } });
  }
  return audio.length / 32;
}

const noPreview = (page) => page.waitForFunction(() => !window.__saywrightStore.get().changes.some((c) => c.status === 'preview'), null, { timeout: 60_000 });

async function openSettings(page, tab) {
  await page.evaluate((t) => window.__saywrightStore.set({ overlay: 'settings', settingsTab: t }), tab);
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  await page.waitForTimeout(900);
}

async function closeOverlay(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

/** Numbered markers drawn over the page for one picture, next to what each names; `remove()` takes them away. */
async function markers(page, spots) {
  const placed = [];
  for (const [n, locator, side] of spots) {
    const b = await locator.boundingBox();
    if (b) placed.push({ n, side, b });
  }
  await page.evaluate((list) => {
    const layer = document.createElement('div');
    layer.id = 'doc-markers';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    for (const { n, side, b } of list) {
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:${b.x - 3}px;top:${b.y - 3}px;width:${b.width + 6}px;height:${b.height + 6}px;border:2px solid #ffb224;border-radius:9px;box-shadow:0 0 0 3px rgba(255,178,36,.18)`;
      const dot = document.createElement('div');
      const at = {
        below: [b.x + b.width / 2 - 12, b.y + b.height + 3],
        above: [b.x + b.width / 2 - 12, b.y - 29],
        left: [b.x - 31, b.y + b.height / 2 - 12],
        right: [b.x + b.width + 7, b.y + b.height / 2 - 12],
      }[side];
      dot.textContent = String(n);
      dot.style.cssText = `position:fixed;left:${at[0]}px;top:${at[1]}px;width:24px;height:24px;border-radius:50%;background:#ffb224;color:#1b1203;font:700 13px/24px 'Geist Variable',ui-sans-serif,system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.45)`;
      layer.append(ring, dot);
    }
    document.body.append(layer);
  }, placed);
  return { remove: () => page.evaluate(() => document.getElementById('doc-markers')?.remove()) };
}

// ───────────────────────────── first run: no AI ─────────────────────────────

async function firstRun(browser, only) {
  const want = (name) => !only || only.includes(name);
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  // Nothing linked yet: the welcome. Its sample shop is this run's copy of the shop.
  const { apps } = await api('GET', '/apps');
  const shop = apps.find((a) => a.root);
  await api('POST', '/apps/close');
  let fresh = true;
  const page = await openStudio(context, 'dark', { onboarded: false, wait: false });
  await page.route('**/api/apps', async (route) => {
    if (!fresh || route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), apps: [], active: null } });
  });
  await page.route('**/api/apps/sample', async (route) => route.fulfill({ response: await route.fetch({ url: `${STUDIO}/api/apps/${shop.id}/open`, method: 'POST', postData: '{}' }) }));
  await page.reload();
  const welcome = page.locator('[data-welcome]');
  await welcome.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  if (want('welcome')) await shot(page, 'welcome');
  fresh = false;

  // Try the sample shop: the tour's first step on the live studio.
  await welcome.locator('[data-try-sample]').click();
  const point = page.getByRole('dialog', { name: 'Point at something' });
  await point.waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => window.__saywrightStore?.get().app.connected, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  if (want('tour')) await shot(page, 'tour');
  await page.locator('[data-tour-card]').getByRole('button', { name: 'Skip tour' }).click();
  await page.waitForTimeout(600);
  await page.unroute('**/api/apps');

  if (want('apps') || want('link-app')) {
    await page.locator('[data-app-switcher]').click();
    await page.getByRole('menuitem', { name: 'All apps' }).click();
    await page.locator('[data-launcher]').waitFor();
    await park(page);
    if (want('apps')) await shot(page, 'apps');
    await page.locator('[data-link-app]').click();
    const link = page.getByRole('dialog', { name: 'Link an app' });
    await link.waitFor();
    // The address tab: the folder tab would show this computer's own folders.
    await link.getByRole('tab', { name: /Address/ }).click();
    await page.waitForTimeout(600);
    if (want('link-app')) await shot(page, 'link-app');
    await closeOverlay(page);
    await closeOverlay(page);
    // Back to the shop.
    await api('POST', `/apps/${shop.id}/open`, {});
    await page.reload();
    await page.waitForFunction(() => window.__saywrightStore?.get().app.connected, null, { timeout: 60_000 });
    await page.waitForTimeout(1200);
  }

  for (const [name, tab] of [
    ['settings-ai', 'ai'],
    ['settings-voice', 'voice'],
    ['settings-mcp', 'mcp'],
  ]) {
    if (!want(name)) continue;
    await openSettings(page, tab);
    await shot(page, name);
    await closeOverlay(page);
  }

  if (want('palette')) {
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
    await page.keyboard.type('test');
    await page.waitForTimeout(600);
    await shot(page, 'palette');
    await closeOverlay(page);
  }

  if (want('shortcuts')) {
    await page.locator('body').click({ position: { x: 4, y: H - 4 } });
    await page.keyboard.press('?');
    await page.getByRole('dialog', { name: 'Phrases and shortcuts' }).waitFor();
    await page.waitForTimeout(600);
    await shot(page, 'shortcuts');
    await closeOverlay(page);
  }
  await context.close();
}

// ───────────────────────────── with an AI ─────────────────────────────

async function withAi(browser, only) {
  const want = (name) => !only || only.includes(name);
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await openStudio(context, 'dark');
  const app = frame(page);

  // The screen, explained: the Pay button selected, its Inspect tab, numbered for the guide.
  await page.keyboard.press('e');
  await clickInApp(page, 'pay-button');
  await page.waitForFunction(() => window.__saywrightStore.get().selection?.name === 'Button');
  await page.getByRole('tab', { name: /Inspect/ }).click();
  await park(page);
  await page.waitForTimeout(600);
  if (want('overview')) {
    const m = await markers(page, [
      [1, page.locator('[data-app-switcher]'), 'right'],
      [2, page.locator('[data-mode-switcher]'), 'below'],
      [3, page.locator('[data-tour="record"]'), 'below'],
      [4, page.locator('[data-tour="ai"]'), 'below'],
      [5, page.locator('aside[aria-hidden="false"]'), 'left'],
      [6, app.getByTestId('pay-button'), 'left'],
      [7, page.locator('[data-tour="dock"]'), 'left'],
    ]);
    await shot(page, 'overview');
    await m.remove();
  }
  if (want('inspect')) await shot(page, 'inspect', await panel(page));

  // Say what to change: a quick edit, previewed; Enter keeps it.
  await clickInApp(page, 'pay-button'); // deselect
  await clickInApp(page, 'coupon-apply');
  await page.waitForFunction(() => window.__saywrightStore.get().selection?.name === 'Button');
  await say(page, 'make this bigger');
  await island(page, 'preview').waitFor({ timeout: 120_000 });
  await park(page);
  await page.waitForTimeout(900);
  if (want('preview')) await shot(page, 'preview');
  await page.keyboard.press('Enter');
  await noPreview(page);
  await page.getByRole('tab', { name: /Changes/ }).click();
  // Opened, to show its diff.
  await page.locator('[data-change] > button').first().click();
  await park(page);
  await page.waitForTimeout(800);
  if (want('changes')) await shot(page, 'changes', await panel(page));

  // This and that: two things selected, the first is “this”.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await clickInApp(page, 'coupon-apply');
  await clickInApp(page, 'pay-button', ['Shift']);
  await park(page);
  await page.waitForTimeout(700);
  if (want('this-that')) await shot(page, 'this-that');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // A question: the answer names the code, file and line.
  if (want('answer')) {
    await hoverInApp(page, 'summary-total', 0.85);
    await say(page, 'why is the total wrong when I use SAVE20?');
    await island(page, 'answer').waitFor({ timeout: 180_000 });
    await park(page);
    await page.waitForTimeout(900);
    await shot(page, 'answer');
    await closeOverlay(page);
  }

  // Write test: what you do becomes steps, what you say becomes a check, then a test that fails, then the fix.
  if (want('write-test') || want('fix-test')) {
    await page.keyboard.press('r');
    await app.getByTestId('coupon-input').fill('SAVE20');
    await app.getByTestId('coupon-apply').click();
    await page.waitForFunction(() => window.__saywrightStore.get().recorder.steps.length >= 2);
    await hoverInApp(page, 'summary-total', 0.85);
    await say(page, 'this should show $80.80');
    await page.waitForFunction(() => window.__saywrightStore.get().recorder.expectations.length > 0);
    await page.getByRole('button', { name: 'Generate test' }).first().click();
    await page.waitForFunction(() => !!window.__saywrightStore.get().recorder.spec);
    await page.getByRole('button', { name: 'Run it' }).click();
    await page.locator('[data-island]').filter({ hasText: /Test failed/ }).waitFor({ timeout: 120_000 });
    await park(page);
    await page.waitForTimeout(900);
    if (want('write-test')) await shot(page, 'write-test');
    if (want('fix-test')) {
      await page.getByRole('button', { name: /^Fix with / }).first().click();
      await page.locator('[data-island]').filter({ hasText: /The test passes with this fix/ }).waitFor({ timeout: 300_000 });
      await park(page);
      await page.waitForTimeout(900);
      await shot(page, 'fix-test');
      // Keep the bug: the session below is about it.
      await page.keyboard.press('ControlOrMeta+z');
      await noPreview(page);
    }
    await page.keyboard.press('e');
    await page.waitForTimeout(600);
  }

  // Record session: the dialog, the bar while recording, then the report.
  const sessions = !only || ['record', 'recording', 'report-local', 'verify'].some(want);
  if (sessions) {
    // The shop as it starts, without the coupon Write test applied.
    await page.evaluate(() => window.__saywright.reloadApp());
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /Sessions/ }).click();
    await page.locator('[data-tour="record"]').click();
    const start = page.getByRole('button', { name: 'Start recording' });
    await start.waitFor();
    await page.getByPlaceholder('What are you testing? (optional)').fill('Coupon at checkout');
    await park(page);
    await page.waitForTimeout(600);
    if (want('record')) await shot(page, 'record');
    await start.click();
    await page.waitForFunction(() => window.__saywrightSessionsStore?.getState().live.status === 'recording', null, { timeout: 30_000 });
    const sessionId = await page.evaluate(() => window.__saywrightSessionsStore.getState().live.id);
    await app.getByTestId('coupon-input').click();
    await page.keyboard.type('SAVE20', { delay: 60 });
    await app.getByTestId('coupon-apply').click();
    await sleep(1500);
    await park(page);
    if (want('recording')) await shot(page, 'recording');
    // Pointing at the total, the tester says what it should show.
    await hoverInApp(page, 'summary-total', 0.85);
    await sleep((await narrate(sessionId)) + 1500);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    const ready = page.getByRole('button', { name: /Report ready/ });
    await ready.waitFor({ timeout: 300_000 });
    await ready.click();
    const report = page.getByRole('dialog', { name: 'Session report' });
    await report.locator('[data-verdict-badge]').waitFor({ timeout: 300_000 });
    const said = report.locator('[data-findings] article').filter({ hasText: /should show/i }).first();
    const heard = await said.waitFor({ timeout: 15_000 }).then(
      () => true,
      () => (log('no finding from what was said (is the English speech model installed?): no Verify fixes picture'), false),
    );
    await park(page);
    await page.waitForTimeout(1200);
    // The report as it is without an AI: written on this computer from what was recorded.
    if (want('report-local')) await shot(page, 'report-local');

    // Fix it from the report, keep the fix, then play the session again to check it.
    if (want('verify') && heard) {
      await said.getByRole('button', { name: /^Fix with / }).click();
      await island(page, 'preview').waitFor({ timeout: 300_000 });
      await page.keyboard.press('Enter');
      await noPreview(page);
      await page.waitForTimeout(1500);
      await page.evaluate((i) => window.__saywrightSessions.openReport(i), sessionId);
      await report.locator('[data-verify]').click();
      await page.locator('[data-verification="done"]').waitFor({ timeout: 180_000 });
      await said.scrollIntoViewIfNeeded();
      await park(page);
      await page.waitForTimeout(1200);
      await shot(page, 'verify');
    }
    await closeOverlay(page);
  }

  // The Experts: a review of the page.
  if (want('experts')) {
    await page.getByRole('tab', { name: /Experts/ }).click();
    await page.locator('[data-review-page]').click();
    await page.locator('[data-review-page]').filter({ hasText: /Review again/ }).waitFor({ timeout: 120_000 });
    await park(page);
    await page.waitForTimeout(900);
    await shot(page, 'experts', await panel(page));
  }

  if (want('sessions')) {
    await page.getByRole('tab', { name: /Sessions/ }).click();
    await park(page);
    await page.waitForTimeout(900);
    await shot(page, 'sessions', await panel(page));
  }

  // Usage: what today's requests cost. (Settings → AI would show the key: it is taken in the first pass.)
  if (want('usage')) {
    await openSettings(page, 'usage');
    await shot(page, 'usage');
    await closeOverlay(page);
  }
  await context.close();
}

// ───────────────────────────── main ─────────────────────────────

/** One pass in this process: its own studio, shop copy and browser. */
async function runPass(pass, only) {
  const servers = await serve({ ai: pass === 'first' ? 'none' : REAL ? 'real' : 'stand-in' });
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--force-device-scale-factor=1'],
  });
  try {
    await prepareStudio({ tour: pass === 'first' });
    // The first load compiles the studio.
    const warm = await browser.newContext({ viewport: { width: W, height: H } });
    await openStudio(warm, 'dark', { wait: pass !== 'first' });
    await warm.close();
    await (pass === 'first' ? firstRun : withAi)(browser, only);
  } catch (err) {
    // What the studio showed when it went wrong.
    const page = browser.contexts().flatMap((c) => c.pages()).at(-1);
    if (page) await page.screenshot({ path: path.join(WORK, 'failed.png') }).then(() => log(`what the studio showed: ${path.relative(ROOT, path.join(WORK, 'failed.png'))}`), () => {});
    throw err;
  } finally {
    await browser.close();
    await servers.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.split(',') : null;
  const pass = args.includes('--pass') ? args[args.indexOf('--pass') + 1] : null;
  checkFfmpeg();
  if (pass) return runPass(pass, only);
  // Each pass in its own process: the studio's server keeps state for the life of a process.
  for (const p of PASSES) {
    log(`pass: ${p}`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--pass', p, ...(only ? ['--only', only.join(',')] : [])], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`The ${p} pass failed.`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`media: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
