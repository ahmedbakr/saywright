#!/usr/bin/env node
/**
 * Records the README's demo: a 60–90 s video of the core story on the sample shop, a GIF of its first beats, and
 * screenshots, all into docs/media/.
 *
 *   node scripts/demo/record.mjs
 *
 * It starts the studio and a throwaway copy of the sample shop (as the end-to-end tests do, in .saywright/demo/),
 * then drives Chromium at 1440×900 through the story, with a caption for each beat drawn over the page for the
 * recording only (it isn't part of the studio):
 *
 *   1 point at the Pay button (its file and line show)   2 type “make it smaller”   3 the live preview; Enter keeps it
 *   4 the diff in Changes   5 a recorded session (apply SAVE20, look at the total), then its report
 *   6 Autopilot on “Apply SAVE20 at checkout and check the totals”, and what it finds, tied to the code
 *
 * Frames come from Chromium's screencast and are encoded with ffmpeg into:
 *
 *   docs/media/demo.mp4                               H.264, the whole story (at most 6 MB)
 *   docs/media/demo.gif                               960 px wide, 12 fps: point → say → keep (at most 8 MB)
 *   docs/media/studio-light.png, studio-dark.png      a change waiting to be kept, in each theme
 *   docs/media/report.png                             the report Autopilot's run ends in, with its finding
 *   docs/media/autopilot.png                          Autopilot at work
 *
 * The AI is the studio's test stand-in unless DEMO_AI=real is set with ANTHROPIC_API_KEY: then the real Claude
 * answers (a few cents of API use) and the waits for it are cut from the video. Other settings:
 *
 *   DEMO_STUDIO_PORT, DEMO_SHOP_PORT   where the studio and the shop copy listen (7521, 7522)
 *   PW_CHROMIUM_PATH                   a Chromium to use instead of Playwright's own
 *   FFMPEG                             the ffmpeg to use (default: ffmpeg on the PATH)
 *   DEMO_KEEP=1                        keep the frames and the encoding lists in .saywright/demo/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { ROOT } from '../lib/paths.mjs';
import { H, MEDIA, REAL, STUDIO, W, WORK, api, checkFfmpeg, ffmpeg, frame, log, openStudio, prepareStudio, screenshot, serve, size, sleep } from './stage.mjs';

const LIMITS = { mp4: 6e6, gif: 8e6 };
/** What Autopilot is asked to try in the last beat. */
const GOAL = 'Apply SAVE20 at checkout and check the totals';

function checkTools() {
  checkFfmpeg();
  // The recorded session measures how quickly the shop answers: on a busy computer it says the shop is slow.
  const load = os.loadavg()[0];
  if (load > os.cpus().length) log(`this computer is busy (load ${load.toFixed(1)} on ${os.cpus().length} cores): the recorded session may report slow responses that aren’t the shop’s.`);
}

// ───────────────────────────── recording ─────────────────────────────

/** Chromium's screencast, one JPEG per repaint with its time, written to .saywright/demo/frames. */
async function capture(page) {
  const dir = path.join(WORK, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const writes = [];
  await page.screencast.start({
    size: { width: W, height: H },
    quality: 92,
    onFrame: ({ data }) => {
      const file = path.join(dir, `${String(frames.length + 1).padStart(6, '0')}.jpg`);
      frames.push({ file, t: Date.now() / 1000 });
      writes.push(fs.promises.writeFile(file, data));
    },
  });
  return {
    frames,
    async stop() {
      await page.screencast.stop();
      await Promise.all(writes);
      return Date.now() / 1000;
    },
  };
}

/** The pointer and the captions, drawn over the studio for the recording (the screencast shows no system cursor). */
function installOverlay() {
  const css = `
    #demo-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:26px;height:26px;transform:translate(-100px,-100px);transition-property:transform;transition-timing-function:cubic-bezier(.45,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
    #demo-cursor svg{display:block;transform-origin:3px 2px;transition:transform 90ms ease}
    #demo-cursor.down svg{transform:scale(.86)}
    .demo-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:2.5px solid #ffb224;animation:demo-ripple 520ms ease-out forwards}
    @keyframes demo-ripple{from{transform:scale(.35);opacity:1}to{transform:scale(1.35);opacity:0}}
    #demo-caption{position:fixed;right:22px;bottom:22px;z-index:2147483645;pointer-events:none;max-width:400px;display:flex;gap:12px;align-items:flex-start;padding:13px 17px 14px 14px;border-radius:14px;background:rgba(14,15,19,.92);color:#f4f4f6;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 14px 34px -10px rgba(0,0,0,.6);font:500 17px/1.4 'Geist Variable',ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em;transition:opacity 220ms ease,transform 220ms ease}
    #demo-caption.hide{opacity:0;transform:translateY(6px)}
    #demo-caption b{flex:none;display:flex;align-items:center;justify-content:center;width:26px;height:26px;margin-top:-1px;border-radius:50%;background:#ffb224;color:#1b1203;font-size:14px;font-weight:700}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15.2 L18.6 15.2 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const caption = document.createElement('div');
  caption.id = 'demo-caption';
  caption.className = 'hide';
  for (const el of [cursor, caption]) el.setAttribute('aria-hidden', 'true');
  document.body.append(cursor, caption);
  window.__demo = {
    move(x, y, ms) {
      cursor.style.transitionDuration = `${ms}ms`;
      cursor.style.transform = `translate(${x - 3}px,${y - 2}px)`;
    },
    press(down) {
      cursor.classList.toggle('down', down);
    },
    ripple(x, y) {
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.body.append(r);
      setTimeout(() => r.remove(), 600);
    },
    caption(n, text) {
      caption.classList.add('hide');
      setTimeout(() => {
        caption.innerHTML = '';
        if (n) caption.append(Object.assign(document.createElement('b'), { textContent: String(n) }));
        caption.append(Object.assign(document.createElement('span'), { textContent: text }));
        caption.classList.toggle('hide', !text);
      }, 230);
    },
  };
}

/** Moves the drawn pointer and the real one together, so hovering shows what it would. */
class Director {
  constructor(page, startedAt) {
    this.page = page;
    this.at = { x: 520, y: 480 };
    this.cuts = [];
    this.marks = { start: startedAt };
    /** When each caption came up, for the log. */
    this.beats = [];
  }

  mark(name) {
    this.marks[name] = Date.now() / 1000;
  }

  async caption(n, text) {
    if (text) this.beats.push(`${n}@${(Date.now() / 1000 - this.marks.start).toFixed(1)}s`);
    await this.page.evaluate(([n, t]) => window.__demo.caption(n, t), [n, text]);
  }

  async move(x, y, ms = 650) {
    const from = this.at;
    await this.page.evaluate(([x, y, ms]) => window.__demo.move(x, y, ms), [x, y, ms]);
    const steps = Math.max(6, Math.round(ms / 30));
    const t0 = Date.now();
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      // On the clock, so a move takes as long as the drawn pointer's does however slow each step is.
      const wait = t0 + (ms * i) / steps - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.at = { x, y };
  }

  /** Over the middle of what `locator` shows (fx, fy: where in it), in the page's coordinates. */
  async over(locator, fx = 0.5, fy = 0.5, ms) {
    await locator.waitFor({ state: 'visible', timeout: 60_000 });
    const b = await locator.boundingBox();
    if (!b) throw new Error(`Nothing to point at for ${locator}`);
    await this.move(Math.round(b.x + b.width * fx), Math.round(b.y + b.height * fy), ms);
  }

  async click(locator, fx, fy, ms) {
    if (locator) await this.over(locator, fx, fy, ms);
    await sleep(160);
    await this.page.evaluate(([x, y]) => (window.__demo.press(true), window.__demo.ripple(x, y)), [this.at.x, this.at.y]);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    await this.page.evaluate(() => window.__demo.press(false));
  }

  async type(text, delay = 75) {
    await this.page.keyboard.type(text, { delay });
  }

  async press(key) {
    await this.page.keyboard.press(key);
  }

  hold(ms) {
    return sleep(ms);
  }

  /** Until Autopilot is done: its steps stay in the video, and only long pauses while it thinks are cut. */
  async autopilot() {
    let since = null;
    const until = Date.now() + 600_000;
    for (;;) {
      if (Date.now() > until) throw new Error('Autopilot didn’t finish in 10 minutes.');
      const phase = await this.page.evaluate(() => document.querySelector('[data-autopilot]')?.getAttribute('data-autopilot') ?? null);
      const now = Date.now() / 1000;
      const idle = phase === 'starting' || phase === 'thinking' || phase === 'finishing';
      if (idle && since === null) since = now;
      if (!idle && since !== null) {
        if (now - since > 2.5) this.cuts.push([since + 1, now - 0.3]);
        since = null;
      }
      if (!phase) return;
      await sleep(100);
    }
  }

  /** Waits for `what`; a long wait (a report being written, a real AI thinking) is cut to its first and last moments. */
  async wait(what) {
    const from = Date.now() / 1000;
    const out = await what;
    const to = Date.now() / 1000;
    if (to - from > 2.5) this.cuts.push([from + 1, to - 0.4]);
    return out;
  }
}

// ───────────────────────────── the story ─────────────────────────────

async function story(d) {
  const { page } = d;
  const app = frame(page);

  // From the empty stage under the app: nothing is pointed at yet.
  await d.move(520, 818, 10);
  await d.hold(700);

  // 1 · Point.
  await d.caption(1, 'Point at anything in your app. Saywright shows where it lives in your code.');
  await d.hold(1200);
  await d.over(app.getByTestId('summary-subtotal'), 0.3, 0.5, 800);
  await d.hold(900);
  await d.click(app.getByTestId('pay-button'), 0.5, 0.5, 600);
  await page.waitForFunction(() => window.__saywrightStore.get().selection?.name === 'Button');
  await d.hold(2600);

  // 2 · Say (or type) what to change.
  await d.caption(2, 'Say or type what to change.');
  await d.click(page.getByRole('textbox', { name: 'Describe a change' }), 0.3, 0.5, 500);
  await d.hold(400);
  await d.type('make it smaller', 95);
  await d.hold(800);
  await d.press('Enter');

  // 3 · The live preview: Enter keeps it.
  await d.wait(page.locator('[data-island="preview"]').waitFor({ timeout: 120_000 }));
  await d.caption(3, 'It’s live, in your app and in your code. Enter keeps it; Ctrl Z puts it back.');
  await d.over(page.locator('[data-island="preview"]').getByRole('button', { name: 'Keep' }), 0.5, 0.5, 700);
  await d.hold(3000);
  await d.press('Enter');
  await page.waitForFunction(() => !window.__saywrightStore.get().changes.some((c) => c.status === 'preview'));
  await d.hold(1600);
  d.mark('kept');

  // 4 · The diff in Changes.
  await d.caption(4, 'Every change is listed with its diff and file. Nothing is committed unless you say so.');
  await d.over(page.locator('[data-change]').first().locator('.bg-sunken').first(), 0.35, 0.55, 900);
  await d.hold(3200);
  // Done with the Pay button: its tag would cover the total.
  await d.click(page.locator('[data-tour="dock"]').getByRole('button', { name: 'Deselect' }), 0.5, 0.5, 900);
  await d.hold(500);

  // 5 · A recorded session, then its report.
  await d.caption(5, 'Record a session: use your app as you would, then get a report.');
  await d.click(page.locator('[data-tour="record"]'), 0.5, 0.5, 900);
  await d.hold(900);
  await d.click(page.getByRole('button', { name: 'Start recording' }), 0.5, 0.5, 700);
  await page.waitForFunction(() => window.__saywrightSessionsStore?.getState().live.status === 'recording', null, { timeout: 30_000 });
  await d.hold(800);
  await d.click(app.getByTestId('coupon-input'), 0.4, 0.5, 900);
  await d.type('SAVE20', 110);
  await d.hold(300);
  await d.click(app.getByTestId('coupon-apply'), 0.5, 0.5, 600);
  await d.hold(900);
  await d.over(app.getByTestId('summary-discount'), 0.85, 0.5, 700);
  await d.hold(1100);
  await d.over(app.getByTestId('summary-total'), 0.85, 0.5, 600);
  await d.hold(1700);
  await d.click(app.getByRole('button', { name: 'Remove' }), 0.5, 0.5, 700);
  await d.hold(500);
  await d.click(page.getByRole('button', { name: 'Stop', exact: true }), 0.5, 0.5, 900);
  await d.wait(page.getByRole('button', { name: /Report ready/ }).waitFor({ timeout: 300_000 }));
  await d.hold(500);
  await d.click(page.getByRole('button', { name: /Report ready/ }), 0.5, 0.5, 800);
  const report = page.getByRole('dialog', { name: 'Session report' });
  await report.locator('[data-verdict-badge]').waitFor();
  // Nothing was said: a finding about the coupon comes from what the screen showed once Apply was clicked.
  const spotted = report.locator('[data-findings] article').filter({ hasText: /shipping/i }).first();
  const seenByReport = (await spotted.count()) > 0;
  await d.caption(5, seenByReport ? 'The report checks what the screen showed: SAVE20 also takes 20% off shipping.' : 'The report: what happened, scored, with the evidence and where it is in the code.');
  await d.hold(1400);
  // Where in the code: the coupon finding's place, or the first place the report names (a finding's, or the timeline's).
  const code = (seenByReport ? spotted : report).getByText(/\.(tsx|ts|jsx|js|vue|svelte|astro|html):\d+/).first();
  await code.scrollIntoViewIfNeeded();
  await d.over(code, 0.5, 0.5, 900);
  await d.hold(3000);

  // 6 · Autopilot, and what it finds.
  await d.caption(6, 'Autopilot: the AI uses your app like a tester.');
  const tryIt = report.locator('[data-try-autopilot]');
  if (await tryIt.isVisible()) await d.click(tryIt, 0.5, 0.5, 900);
  else {
    await d.press('Escape');
    await d.click(page.getByRole('tab', { name: /Sessions/ }), 0.5, 0.5, 800);
  }
  await report.waitFor({ state: 'hidden' });
  await d.click(page.locator('[data-autopilot-goal]'), 0.3, 0.5, 700);
  await d.type(GOAL, 38);
  await d.hold(500);
  await d.click(page.locator('[data-autopilot-start]'), 0.5, 0.5, 700);
  await page.locator('[data-autopilot]').waitFor();
  await d.move(1180, 560, 900);
  await d.autopilot();
  await d.wait(report.locator('[data-findings] article').first().waitFor({ timeout: 300_000 }));
  // What it found, in its own words: the caption names the coupon bug only when that is what it found.
  const coupon = report.locator('[data-findings] article').filter({ hasText: /shipping/i }).first();
  const found = (await coupon.count()) ? coupon : report.locator('[data-findings] article').first();
  const caption = !(await coupon.count()) ? 'It reports what it found, with the evidence and where it is in the code.' : seenByReport ? 'Autopilot finds it on its own too, and points to the code.' : 'It finds the bug: SAVE20 also takes 20% off shipping, and points to the code.';
  await d.caption(6, caption);
  await found.scrollIntoViewIfNeeded();
  await d.hold(700);
  const where = found.getByText(/\.(tsx|ts|jsx|js|vue|svelte|astro|html):\d+/).first();
  await d.over((await where.count()) ? where : found, 0.5, 0.5, 1000);
  await d.hold(4200);
  await d.caption(0, '');
  await d.hold(500);
}

// ───────────────────────────── encoding ─────────────────────────────

/**
 * An ffconcat list of the frames between `from` and `to` (seconds), each shown until the next, with the cut spans
 * taken out. Frames only come when the page repaints, so this is what turns them into steady video.
 */
function concatList(frames, from, to, cuts, file) {
  const lines = ['ffconcat version 1.0'];
  const kept = (a, b) => {
    let len = Math.max(0, Math.min(b, to) - Math.max(a, from));
    for (const [c0, c1] of cuts) len -= Math.max(0, Math.min(b, to, c1) - Math.max(a, from, c0));
    return Math.max(0, len);
  };
  let last = null;
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i].t;
    const b = i + 1 < frames.length ? frames[i + 1].t : to;
    const len = kept(a, b);
    if (len < 0.001) continue;
    last = `file '${frames[i].file.replace(/'/g, "'\\''")}'`;
    lines.push(last, `duration ${len.toFixed(4)}`);
  }
  // The concat demuxer only honours the last duration when its file is listed once more.
  if (last) lines.push(last);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

function encodeMp4(list, out) {
  for (const crf of [24, 27, 30, 33]) {
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-tune', 'animation', '-movflags', '+faststart', out]);
    if (size(out) <= LIMITS.mp4) return log(`${path.relative(ROOT, out)}: ${mb(size(out))} (crf ${crf})`);
  }
  throw new Error(`${out} is over ${mb(LIMITS.mp4)}`);
}

function encodeGif(list, out) {
  for (const [colors, fps] of [
    [192, 12],
    [128, 12],
    [96, 10],
  ]) {
    const vf = `fps=${fps},scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-loop', '0', out]);
    if (size(out) <= LIMITS.gif) return log(`${path.relative(ROOT, out)}: ${mb(size(out))} (${colors} colours, ${fps} fps)`);
  }
  throw new Error(`${out} is over ${mb(LIMITS.gif)}`);
}

// ───────────────────────────── screenshots ─────────────────────────────

/** The core loop in one picture, in each theme: the Pay button selected (its file and line), a change waiting, its diff. */
async function studioShots(browser) {
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await openStudio(context, 'light');
  const pay = await frame(page).getByTestId('pay-button').boundingBox();
  await page.mouse.click(pay.x + pay.width / 2, pay.y + pay.height / 2);
  await page.waitForFunction(() => window.__saywrightStore.get().selection?.name === 'Button');
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make it secondary');
  await page.keyboard.press('Enter');
  await page.locator('[data-island="preview"]').waitFor({ timeout: 120_000 });
  await page.mouse.move(W - 4, H - 4);
  await page.waitForTimeout(900);
  await screenshot(page, 'studio-light.png');
  await page.evaluate(() => window.__saywrightSettings.getState().set({ theme: 'dark' }));
  await page.waitForTimeout(700);
  await screenshot(page, 'studio-dark.png');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(() => !window.__saywrightStore.get().changes.some((c) => c.status === 'preview'));
  await context.close();
}

async function autopilotShots(browser, reportId) {
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await openStudio(context, 'dark');
  // Autopilot at work: its step on the island, its pointer on the control it is using.
  await page.getByRole('tab', { name: /Sessions/ }).click();
  await page.locator('[data-autopilot-goal]').fill(GOAL);
  await page.locator('[data-autopilot-start]').click();
  // At the coupon, ideally; any step from the third on will do for an AI that goes another way.
  await page.waitForFunction(
    () => {
      const island = document.querySelector('[data-autopilot="acting"]');
      const step = Number(/step (\d+) of/.exec(island?.textContent ?? '')?.[1] ?? 0);
      return !!island && (/coupon|SAVE20|Apply/i.test(document.querySelector('[data-autopilot-step]')?.textContent ?? '') || step >= 3);
    },
    null,
    { timeout: 300_000 },
  );
  await page.mouse.move(W - 4, H - 4);
  await page.waitForTimeout(450);
  await screenshot(page, 'autopilot.png');
  // That was all this run was for.
  await page.locator('[data-autopilot-stop]').click();
  await page.locator('[data-autopilot]').waitFor({ state: 'detached', timeout: 120_000 });
  await context.close();

  // The report of the run recorded for the video: what it found, with its scores and timeline.
  const shot = await browser.newContext({ viewport: { width: W, height: H } });
  const reportPage = await openStudio(shot, 'dark');
  await reportPage.goto(`${STUDIO}/report/${reportId}`);
  await reportPage.locator('[data-findings] article').first().waitFor({ timeout: 120_000 });
  await reportPage.waitForTimeout(900);
  await screenshot(reportPage, 'report.png');
  await shot.close();
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  checkTools();
  fs.mkdirSync(MEDIA, { recursive: true });
  const servers = await serve({ ai: REAL ? 'real' : 'stand-in' });
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    // No camera or microphone prompt can stop the story.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--force-device-scale-factor=1'],
  });
  try {
    await prepareStudio();
    // The first load compiles the studio: not part of the film.
    const warm = await browser.newContext({ viewport: { width: W, height: H } });
    await openStudio(warm, 'dark');
    await warm.close();

    const context = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await openStudio(context, 'dark');
    await page.evaluate(installOverlay);
    const film = await capture(page);
    await sleep(300);
    const d = new Director(page, Date.now() / 1000);
    log('recording the story…');
    await story(d);
    const end = await film.stop();
    await context.close();
    const cut = d.cuts.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
    log(`recorded ${(end - d.marks.start).toFixed(1)} s in ${film.frames.length} frames${cut ? `, ${cut.toFixed(1)} s of waiting cut` : ''}; captions at ${d.beats.join(' ')}`);

    const mp4List = concatList(film.frames, d.marks.start, end, d.cuts, path.join(WORK, 'demo.txt'));
    encodeMp4(mp4List, path.join(MEDIA, 'demo.mp4'));
    const gifList = concatList(film.frames, d.marks.start, d.marks.kept, d.cuts, path.join(WORK, 'gif.txt'));
    encodeGif(gifList, path.join(MEDIA, 'demo.gif'));

    log('screenshots…');
    await studioShots(browser);
    const { sessions } = await api('GET', '/sessions');
    const run = sessions.find((s) => s.source === 'autopilot');
    await autopilotShots(browser, run.id);
  } finally {
    await browser.close();
    await servers.close();
    if (!process.env.DEMO_KEEP) fs.rmSync(path.join(WORK, 'frames'), { recursive: true, force: true });
  }
  log(`done: ${path.relative(ROOT, MEDIA)}/`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`demo: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
