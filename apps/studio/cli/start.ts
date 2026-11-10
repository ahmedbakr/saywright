/** `saywright`: start the studio on this computer and open it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { STUDIO_PORT } from '@saywright/vite/protocol';
import { serveStudio } from '../server/standalone.ts';
import { openBrowser } from './browser.ts';
import type { CliContext } from './index.ts';
import { c, fail, warn } from './term.ts';

const HELP = `
${c.bold('saywright')} [options]: start the studio and open it

  --port <number>    where the studio listens (default ${STUDIO_PORT}; with --port, exactly there)
  --no-open          don't open a browser
  --target <url>     open this app straight away (it must be running)
  --root <folder>    where that app's code is, when it can't say (Next.js, Create React App)
`;

/** A studio that already answers on the port: this one again, or another copy. */
async function running(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok && typeof ((await res.json()) as { version?: unknown }).version === 'string';
  } catch {
    return false;
  }
}

export async function start(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: 'string', short: 'p' }, open: { type: 'boolean', default: true }, target: { type: 'string' }, root: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowNegative: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!ctx.clientDir || !fs.existsSync(path.join(ctx.clientDir, 'index.html'))) {
    fail('The studio’s interface isn’t built.', ctx.clientDir ? 'Reinstall Saywright (npx @saywright/studio@latest).' : 'In the repository, start it with npm run dev.');
    return 1;
  }
  // Digits only: Number() would take 1e3, 0x1D10 or " 7441 " as ports.
  const port = values.port === undefined ? STUDIO_PORT : /^\d{1,5}$/.test(values.port) ? Number(values.port) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`--port takes a number from 1 to 65535, not “${values.port}”.`);
    return 1;
  }
  // Checked before anything starts: a studio that starts anyway would open no app and leave the person guessing why.
  if (values.target !== undefined && !isAppAddress(values.target)) {
    fail(`--target takes the address of a running app, like http://localhost:3000, not “${values.target}”.`);
    return 1;
  }
  if (values.root !== undefined && values.target === undefined) {
    fail('--root says where the code of the app given with --target is: give --target too.', 'To link an app’s folder, start the studio and choose Link an app.');
    return 1;
  }
  const open = values.open && !process.env.CI;
  if (await running(port)) {
    console.log(`Saywright is already running at ${c.cyan(`http://localhost:${port}`)}.`);
    if (open) openBrowser(`http://localhost:${port}`);
    return 0;
  }
  if (values.target) process.env.SAYWRIGHT_TARGET_URL = values.target;
  if (values.root) process.env.SAYWRIGHT_TARGET_ROOT = path.resolve(values.root);

  const studio = await serveStudio({ ...ctx.layout, clientDir: ctx.clientDir, port, strictPort: values.port !== undefined });
  const home = shortHome(ctx.layout.dataDir);
  console.log(`\n  ${c.amber('◉')} ${c.bold('Saywright')} ${c.dim(ctx.layout.version)}  ${c.dim('point at your app, say what to change')}\n`);
  console.log(`  ${c.dim('Studio'.padEnd(9))}${c.cyan(studio.url)}`);
  console.log(`  ${c.dim('Data'.padEnd(9))}${home}`);
  if (!studio.url.endsWith(`:${STUDIO_PORT}`) && values.port === undefined) {
    warn(`Port ${STUDIO_PORT} is taken by another program, so the studio is on ${studio.url}. Apps connected with a script tag look for it on ${STUDIO_PORT}.`);
  }
  console.log(c.dim('\n  Ctrl+C to stop.\n'));
  if (open) openBrowser(studio.url);

  // Runs until Ctrl+C: the studio stops the apps it started, then the process ends (a second Ctrl+C doesn't wait).
  // Closing the terminal (SIGHUP) and a crash do the same: the dev servers are in process groups of their own, which
  // nothing else would stop.
  return new Promise<number>(() => {
    let stopping = false;
    const stop = (code: number) => {
      if (stopping) process.exit(1);
      stopping = true;
      void studio.close().finally(() => process.exit(code));
    };
    process.on('SIGINT', () => stop(0));
    process.on('SIGTERM', () => stop(0));
    process.on('SIGHUP', () => stop(129));
    const crash = (err: unknown) => {
      fail(`The studio stopped on an error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      stop(1);
    };
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
  });
}

/** A folder in the home folder as ~/…: only under it, not beside it (/home/al is not the start of /home/alice). */
export function shortHome(dir: string, home = os.homedir()): string {
  if (dir === home) return '~';
  return dir.startsWith(home.endsWith(path.sep) ? home : home + path.sep) ? `~${path.sep}${dir.slice(home.length).replace(/^[\\/]+/, '')}` : dir;
}

/** An http(s) address, as a running app has. */
function isAppAddress(text: string): boolean {
  try {
    return /^https?:$/.test(new URL(text).protocol);
  } catch {
    return false;
  }
}
