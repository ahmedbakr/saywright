// `npm run dev`: start the studio and open it in the browser. It opens on your apps: pick one (the
// studio starts its dev server) or link another, from a folder, an address or a GitHub repository.
//
//   npm run dev                                   the app list
//   npm run dev -- --target http://localhost:3000 straight into an app that is already running
//   npm run dev -- --root ../my-app               where that app's code is (when it can't say: Next.js, CRA)
//   npm run dev -- --sample                       straight into the sample shop
//   npm run dev -- --no-open                      don't open a browser
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { moveOldModels, SHOP_DIR, STUDIO_DIR } from './lib/paths.mjs';
import { ensurePlugin } from './lib/plugin.mjs';
import { c } from './lib/term.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1];
};

// The same versions as the package's engines (and bin/saywright.mjs).
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major > 24)) {
  console.error(c.red(`✗ Saywright needs Node.js 22.18 or newer (or 24.11 or newer); this is ${process.versions.node}. Install the current LTS from https://nodejs.org, then run npm install again.`));
  process.exit(1);
}

// The plugin is built on install; rebuild it if it was cleaned or its sources changed (after a pull).
if (!ensurePlugin({ log: () => console.log(c.dim('… Building the Saywright Vite plugin')) })) process.exit(1);
moveOldModels();

const servers = [];
// Dev servers the studio started for your apps are stopped by the studio as it closes.
const shutdown = async (code = 0) => {
  await Promise.allSettled(servers.map((s) => s.close()));
  process.exit(code);
};

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.status < 500)
      .catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

let targetUrl = value('target') ?? process.env.SAYWRIGHT_TARGET_URL;
if (value('root')) process.env.SAYWRIGHT_TARGET_ROOT = path.resolve(value('root'));
try {
  if (has('sample')) {
    const shop = await createServer({
      root: SHOP_DIR,
      configFile: path.join(SHOP_DIR, 'vite.config.ts'),
      server: { port: Number(value('app-port') ?? 5174), strictPort: false, warmup: { clientFiles: ['./src/main.tsx'] } },
      clearScreen: false,
      logLevel: 'warn',
    });
    await shop.listen();
    servers.push(shop);
    targetUrl = shop.resolvedUrls?.local[0] ?? 'http://localhost:5174/';
    process.env.SAYWRIGHT_TARGET_ROOT = SHOP_DIR;
  } else if (targetUrl && !(await waitFor(targetUrl, 1500))) {
    console.warn(c.yellow(`! ${targetUrl} isn’t answering yet. Start your app, then reload the studio.`));
  }
  if (targetUrl) process.env.SAYWRIGHT_TARGET_URL = targetUrl;

  const open = !has('no-open') && !process.env.CI;
  if (open && process.platform === 'darwin' && !process.env.BROWSER && fs.existsSync('/Applications/Google Chrome.app')) {
    // Speech recognition and GPU hand tracking work best in Chrome.
    process.env.BROWSER = 'google chrome';
  }
  const studio = await createServer({
    root: STUDIO_DIR,
    configFile: path.join(STUDIO_DIR, 'vite.config.ts'),
    server: { port: Number(value('port') ?? 7357), strictPort: false, open: open ? '/' : false },
    clearScreen: false,
    logLevel: 'warn',
  });
  await studio.listen();
  servers.push(studio);
  const studioUrl = studio.resolvedUrls?.local[0] ?? 'http://localhost:7357/';

  let ai = null;
  try {
    ai = (await (await fetch(new URL('/api/status', studioUrl), { signal: AbortSignal.timeout(5000) })).json()).ai;
  } catch {
    /* banner without the AI line */
  }

  const line = (k, v) => console.log(`  ${c.dim(k.padEnd(9))}${v}`);
  console.log('');
  console.log(`  ${c.amber('◉')} ${c.bold('Saywright')}  ${c.dim('point at your app, say what to change')}`);
  console.log('');
  line('Studio', c.cyan(studioUrl));
  line('Your app', targetUrl ?? c.dim('pick or link one in the studio'));
  if (ai) {
    const who = ai.source === 'fake' ? c.yellow('test stand-in (SAYWRIGHT_AI=fake)') : ai.who ? c.green(`${ai.who.label} · ${ai.who.model}`) : c.yellow('not connected · quick edits still work · connect one in Settings → AI');
    line('AI', who);
  }
  console.log('');
  console.log(c.dim('  Open the studio in Chrome. Hold Space to talk; press ? for shortcuts.'));
  console.log(c.dim('  Ctrl+C to stop.'));
  console.log('');
} catch (err) {
  console.error(c.red(`✗ ${err instanceof Error ? err.message : err}`));
  await shutdown(1);
}
