/**
 * What the demo video (record.mjs) and the documentation's screenshots (screenshots.mjs) share: a studio and a
 * throwaway copy of the sample shop to film, the studio's API, a browser page settled on the open app, and PNGs
 * small enough for the repository.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { ensurePlugin } from '../lib/plugin.mjs';
import { DATA_DIR, ROOT, SHOP_DIR, STUDIO_DIR } from '../lib/paths.mjs';

export const W = 1440;
export const H = 900;
export const STUDIO_PORT = Number(process.env.DEMO_STUDIO_PORT) || 7521;
export const SHOP_PORT = Number(process.env.DEMO_SHOP_PORT) || 7522;
export const STUDIO = `http://localhost:${STUDIO_PORT}`;
export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
/** DEMO_AI=real: the real Claude answers, with ANTHROPIC_API_KEY. Otherwise the studio's test stand-in. */
export const REAL = process.env.DEMO_AI === 'real';
export const WORK = path.join(ROOT, '.saywright', 'demo');
export const MEDIA = path.join(ROOT, 'docs', 'media');
/** A screenshot over this is brought down to 256 colours. */
const PNG_LIMIT = 400e3;
/** Keys the studio would find in the environment, set aside when no AI is wanted. */
const AI_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log('media:', ...a);
export const size = (file) => fs.statSync(file).size;

export function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

export function checkFfmpeg() {
  if (spawnSync(FFMPEG, ['-version']).status !== 0) throw new Error(`No ffmpeg at “${FFMPEG}”. Install it, or set FFMPEG.`);
}

/**
 * A fresh copy of the sample shop and a fresh studio data folder, both under .saywright/demo (git-ignored), served
 * with Vite. `ai`: 'stand-in' (the studio's test stand-in), 'real' (ANTHROPIC_API_KEY, straight to Anthropic) or
 * 'none' (no AI connected, as a newcomer meets the studio).
 */
export async function serve({ ai }) {
  if (ai === 'real' && !process.env.ANTHROPIC_API_KEY) throw new Error('DEMO_AI=real needs ANTHROPIC_API_KEY set.');
  if (!ensurePlugin()) throw new Error('The Vite plugin didn’t build.');
  const shopCopy = path.join(WORK, 'shop');
  const home = path.join(WORK, 'home');
  for (const dir of [shopCopy, home, path.join(WORK, 'frames')]) fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SHOP_DIR, shopCopy, { recursive: true, filter: (p) => !/node_modules|test-results|tests[\\/]saywright/.test(p) });
  // The copy lives at another depth: point its tsconfig back at the shared base config.
  const tsconfig = path.join(shopCopy, 'tsconfig.json');
  const base = path.relative(shopCopy, path.join(ROOT, 'tsconfig.base.json')).split(path.sep).join('/');
  fs.writeFileSync(tsconfig, fs.readFileSync(tsconfig, 'utf8').replace(/"extends":\s*"[^"]+"/, `"extends": "${base}"`));
  // Its own repository, as an app is: reports name its branch and commit, not this one's.
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Tidewell', '-c', 'user.email=shop@example.com', ...args], { cwd: shopCopy, stdio: 'ignore' });
  if (git('init', '-q', '-b', 'main').status === 0) {
    git('add', '-A');
    git('commit', '-q', '-m', 'Tidewell shop');
  }

  process.env.SAYWRIGHT_HOME = home;
  process.env.SAYWRIGHT_SPEECH_DIR ||= path.join(DATA_DIR, 'speech');
  delete process.env.SAYWRIGHT_AI;
  if (ai === 'stand-in') process.env.SAYWRIGHT_AI = 'fake';
  // The real Claude goes straight to Anthropic, never another endpoint.
  if (ai === 'real') delete process.env.ANTHROPIC_BASE_URL;
  if (ai === 'none') for (const name of AI_KEYS) delete process.env[name];

  const shop = await createServer({ root: shopCopy, configFile: path.join(shopCopy, 'vite.config.ts'), server: { port: SHOP_PORT, strictPort: true }, logLevel: 'warn', clearScreen: false });
  await shop.listen();
  process.env.SAYWRIGHT_TARGET_URL = `http://localhost:${SHOP_PORT}/`;
  process.env.SAYWRIGHT_TARGET_ROOT = shopCopy;
  const studio = await createServer({ root: STUDIO_DIR, configFile: path.join(STUDIO_DIR, 'vite.config.ts'), server: { port: STUDIO_PORT, strictPort: true }, logLevel: 'warn', clearScreen: false });
  await studio.listen();
  const who = { 'stand-in': 'the test stand-in for the AI', real: 'the real Claude', none: 'no AI' }[ai];
  log(`studio on ${STUDIO}, shop copy on http://localhost:${SHOP_PORT} (${who})`);
  return { shopCopy, close: () => Promise.allSettled([studio.close(), shop.close()]) };
}

export async function api(method, route, body) {
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${STUDIO}/api${route}`, init);
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Named like the sample shop a person gets from “Try the sample shop”. `tour`: false marks the tour as seen. */
export async function prepareStudio({ tour = false } = {}) {
  const { apps } = await api('GET', '/apps');
  const shop = apps.find((a) => a.root?.endsWith(`${path.sep}shop`));
  if (shop) await api('PUT', `/apps/${shop.id}`, { name: 'Tidewell (sample shop)' });
  if (!tour) await api('PUT', '/tour', { seen: true });
  if (REAL) await routeToApi();
  return shop;
}

/** The real AI is the Anthropic API key from the environment, for every job: never an AI app this computer may have. */
async function routeToApi() {
  const { connections } = await api('GET', '/ai?refresh=1');
  const anthropic = connections.find((c) => c.id === 'anthropic' && c.status === 'ready');
  if (!anthropic?.models.length) throw new Error('The studio doesn’t see ANTHROPIC_API_KEY as a working key.');
  const pick = (...tiers) => (tiers.map((t) => anthropic.models.find((m) => m.tier === t)).find(Boolean) ?? anthropic.models[0]).id;
  for (const [task, model] of [['code', pick('top', 'balanced')], ['report', pick('balanced', 'top')], ['light', pick('fast', 'balanced')]]) {
    await api('PUT', '/ai/routes', { task, connection: 'anthropic', model });
  }
}

/**
 * A page of the studio, settled on the open app, with settings as a person who has used it would have them.
 * `onboarded`: false leaves the first-run setup to the studio.
 */
export async function openStudio(context, theme, { onboarded = true, wait = true } = {}) {
  await context.addInitScript(
    ([t, o]) => {
      localStorage.setItem('saywright.settings', JSON.stringify({ state: { onboarded: o, theme: t, voice: { engine: 'browser' }, ui: { panelOpen: true, panelTab: 'changes', device: 'fill', commitOnKeep: false } }, version: 2 }));
      localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 }));
    },
    [theme, onboarded],
  );
  const page = await context.newPage();
  await page.goto(`${STUDIO}/`);
  if (wait) {
    await page.waitForFunction(() => window.__saywrightStore?.get().app.connected, null, { timeout: 60_000 });
    await page.waitForTimeout(1200);
  }
  return page;
}

export const frame = (page) => page.frameLocator('iframe');

/**
 * A PNG of the page into docs/media/`name` (a path below it), brought down to 256 colours when it is over 400 KB,
 * as pngquant would. `clip`: the part of the page to keep.
 */
export async function screenshot(page, name, { clip } = {}) {
  const out = path.join(MEDIA, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, clip });
  if (size(out) > PNG_LIMIT) {
    const full = path.join(WORK, path.basename(name));
    fs.renameSync(out, full);
    ffmpeg(['-i', full, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=sierra2_4a', out]);
  }
  log(`${path.relative(ROOT, out)}: ${Math.round(size(out) / 1000)} KB`);
}
