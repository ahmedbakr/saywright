/**
 * `saywright doctor`: check what the studio needs, and say how to fix what's missing. Its output is meant to be
 * pasted into an issue: the versions, the computer, the data folder and the programs the studio uses (the names of
 * proxy variables, never their values). `--json` says the same for a script. It is the one command that asks the npm
 * registry whether a newer release exists (once, briefly, silent offline): it is run on purpose; the studio never asks.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { STUDIO_PORT } from '@saywright/vite/protocol';
import { browserSpeechReady } from '../server/assets.ts';
import { speechDir } from '../server/layout.ts';
import { programExists } from '../server/program.ts';
import { SpeechService, speechEngineLoads } from '../server/speech/service.ts';
import { nodeMessage, nodeSupported, proxyVariables } from '../bin/node-env.mjs';
import { dataDirProblem } from './data-dir.ts';
import { runningStudio } from './connect.ts';
import type { CliContext } from './index.ts';
import { c } from './term.ts';

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });

const answers = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};

/**
 * A program's output, or null when it isn't installed. Asked first: on Windows a missing program goes through
 * cmd.exe, which starts and fails like a program that is there but refuses.
 */
const run = (cmd: string, args: string[]) => {
  if (!programExists(cmd)) return null;
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  return r.error ? null : r;
};

/** The folder's size in bytes, counting at most this many files (a data folder holds a few hundred). */
function sizeOf(dir: string, limit = 20_000): number {
  let bytes = 0;
  let seen = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (++seen > limit) break;
    if (entry.isFile()) {
      try {
        bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
      } catch {
        /* gone meanwhile */
      }
    }
  }
  return bytes;
}
const human = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.round(bytes / 1e3)} KB`);

/** A Chrome, Edge or Chromium on this computer, where a generated test's Playwright can use one. */
function systemBrowser(): string | null {
  const env = process.env;
  const files =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : process.platform === 'win32'
        ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap((dir) => [path.join(dir!, 'Google/Chrome/Application/chrome.exe'), path.join(dir!, 'Microsoft/Edge/Application/msedge.exe')])
        : [];
  const found = [env.PW_CHROMIUM_PATH, ...files].find((f) => f && fs.existsSync(f));
  if (found) return found;
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].find((name) => process.platform !== 'win32' && programExists(name)) ?? null;
}

/** The newest release on the npm registry: one request, three seconds at most; null offline or on any doubt. */
async function latestRelease(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@saywright%2fstudio/latest', { signal: AbortSignal.timeout(3000), headers: { Accept: 'application/json' } });
    const version = res.ok ? ((await res.json()) as { version?: unknown }).version : null;
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

type Status = 'ok' | 'warn' | 'problem' | 'info';

export async function doctor(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(`\n${c.bold('saywright doctor')} [--json]: check what the studio needs, and how to fix what's missing\n\n  --json    the same, as JSON\n`);
    return 0;
  }
  const json = !!values.json;
  const { layout } = ctx;
  const checks: { status: Status; message: string; fix?: string }[] = [];
  const say = (status: Status, message: string, fix?: string) => {
    checks.push({ status, message, ...(fix ? { fix } : {}) });
    if (json) return;
    const mark = { ok: c.green('✓'), warn: c.yellow('!'), problem: c.red('✗'), info: c.dim('·') }[status];
    console.log(`${mark} ${message}${fix ? `\n  ${c.dim(fix)}` : ''}`);
  };
  const ok = (msg: string) => say('ok', msg);
  const warn = (msg: string, fix?: string) => say('warn', msg, fix);
  const bad = (msg: string, fix?: string) => say('problem', msg, fix);
  const info = (msg: string) => say('info', msg);
  if (!json) console.log(c.bold('\nSaywright doctor\n'));
  const latest = latestRelease();
  info(`Saywright ${layout.version} · Node ${process.versions.node} · ${os.type()} ${os.release()} (${process.platform} ${process.arch})`);

  /** One check: what it throws is reported, and the others still run. */
  const check = async (what: string, run: () => unknown) => {
    try {
      await run();
    } catch (err) {
      bad(`Couldn’t check ${what}: ${err instanceof Error ? err.message : err}`);
    }
  };

  // The same versions as the launcher and the package's engines.
  if (nodeSupported()) ok(`Node ${process.versions.node}`);
  else bad(nodeMessage(), 'Install the current LTS from https://nodejs.org.');

  const dataProblem = dataDirProblem(layout.dataDir);
  if (dataProblem) bad(dataProblem);
  else await check('the data folder’s size', () => ok(`Data folder: ${layout.dataDir} (writable, ${human(sizeOf(layout.dataDir))})`));

  if (fs.existsSync(layout.bridgeFile)) ok('The script that makes apps pointable is built');
  else bad('The script that makes apps pointable isn’t built', ctx.clientDir ? 'Reinstall Saywright (npx @saywright/studio@latest).' : 'Run npm run build:plugin.');
  if (ctx.clientDir && !fs.existsSync(path.join(ctx.clientDir, 'index.html'))) bad('The studio’s interface isn’t built', 'Reinstall Saywright (npx @saywright/studio@latest).');

  await check('the on-device voice model', () => {
    if (browserSpeechReady(layout.dataDir)) ok('On-device voice model');
    else warn('On-device voice model not downloaded: voice uses the browser’s recogniser alone', `Run ${ctx.clientDir ? 'npx @saywright/studio setup' : 'npm run setup'} to download it once (28 MB).`);
  });

  await check('the speech engine', () => {
    // Where the engine can't load, no model can run: none is suggested.
    if (!speechEngineLoads()) return warn('The speech engine can’t run on this computer: no speech model to download', 'Narration is still recorded; voice uses the browser’s recogniser.');
    const speech = new SpeechService(speechDir(layout), layout.speechWorker, () => undefined).status();
    const have = speech.models.filter((m) => m.installed);
    const missing = [!speech.active.ar && 'Arabic', !speech.active.en && 'English'].filter(Boolean);
    if (!missing.length) ok(`Speech models: ${have.map((m) => m.label).join(', ')}`);
    else warn(`No speech model for ${missing.join(' or ')}`, `Run ${ctx.clientDir ? 'npx @saywright/studio setup' : 'npm run setup'}, or install one from Settings → Voice in the studio.`);
  });

  // AI: a plan through its official app, an API key, or a model on this computer. Any one is enough.
  const envLocal = path.join(layout.envDir, '.env.local');
  let envText = '';
  try {
    envText = fs.existsSync(envLocal) ? fs.readFileSync(envLocal, 'utf8') : '';
  } catch (err) {
    bad(`Couldn’t read ${envLocal}: ${err instanceof Error ? err.message : err}`, 'Fix its owner, or set SAYWRIGHT_HOME to another folder.');
  }
  const keySet = (...names: string[]) => names.some((n) => process.env[n] || new RegExp(`^\\s*${n}\\s*=\\s*\\S`, 'm').test(envText));
  const ai: string[] = [];
  const claude = run('claude', ['auth', 'status', '--json']);
  if (claude) {
    let signedIn = false;
    try {
      signedIn = !!JSON.parse(claude.stdout).loggedIn;
    } catch {
      /* an older Claude Code */
    }
    if (signedIn) ai.push('your Claude plan (Claude Code)');
    else warn('Claude Code is installed but not signed in', 'Run claude once in a terminal and sign in, to use your Claude plan.');
  }
  const codex = run('codex', ['login', 'status']);
  if (codex) {
    if (codex.status === 0 && !/not logged in/i.test(`${codex.stdout}\n${codex.stderr}`)) ai.push('your ChatGPT plan (Codex)');
    else warn('Codex is installed but not signed in', 'Run codex login, to use your ChatGPT plan.');
  }
  if (run('gemini', ['--version'])?.status === 0) ai.push('Gemini CLI (installed)');
  const profileDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'anthropic');
  let profiles = false;
  try {
    profiles = fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0;
  } catch {
    /* unreadable: not counted */
  }
  if (keySet('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN') || profiles) ai.push('an Anthropic API key');
  if (keySet('OPENAI_API_KEY')) ai.push('an OpenAI API key');
  if (keySet('GEMINI_API_KEY', 'GOOGLE_API_KEY')) ai.push('a Gemini API key');
  if (await answers('http://localhost:11434/api/tags')) ai.push('Ollama');
  if (await answers('http://localhost:1234/v1/models')) ai.push('LM Studio');
  if (ai.length) ok(`AI: ${ai.join(', ')}`);
  else warn('AI: nothing connected yet. Quick edits work without one.', 'Sign in to Claude Code, Codex or Gemini CLI, add an API key in the studio (Settings → AI), or run Ollama.');

  // In the repository, the sample app's Playwright runs generated tests.
  const repoSample = layout.sample.source === layout.sample.root ? layout.sample.root : null;
  if (repoSample) {
    try {
      const { chromium } = createRequire(path.join(repoSample, 'package.json'))('playwright-core') as { chromium: { executablePath(): string } };
      if (fs.existsSync(chromium.executablePath())) ok('Test browser, for the sample app’s generated tests');
      else warn('Test browser not installed (needed to run generated tests)', 'Run npm run setup, or click “Install test browser” in the studio.');
    } catch {
      warn('Playwright isn’t installed in the sample app', 'Run npm install.');
    }
  }

  await check('the programs the studio uses', () => {
    const browser = systemBrowser();
    if (browser) ok(`Browser for generated tests: ${browser}`);
    else warn('No Chrome, Edge or Chromium found for generated tests', 'A test installs Playwright’s own browser when it runs (the Test tab offers it), or install Chrome.');
    if (programExists('git')) ok('git');
    else warn('git isn’t installed', 'Linking a GitHub repository and showing changes as diffs need it.');
    const missing = ['tar', 'bzip2', 'curl'].filter((name) => !programExists(name));
    if (!missing.length) ok('tar, bzip2 and curl');
    else warn(`Not installed: ${missing.join(', ')}`, `${missing.some((m) => m !== 'curl') ? 'Speech models are unpacked with tar and bzip2. ' : ''}${missing.includes('curl') ? 'Downloads fall back to curl when Node’s own request fails.' : ''}`.trim());
  });
  const proxies = proxyVariables();
  if (proxies.length) info(`Proxy variables set: ${[...proxies, ...['NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'].filter((n) => process.env[n])].join(', ')}`);

  // A studio running now says where it listens (it may have moved off its usual port): that is where it is.
  const running = await runningStudio(layout.dataDir);
  if (running) ok(`The studio is running at ${running}`);
  const ports: Array<[number, string]> = running ? [] : [[STUDIO_PORT, 'the studio']];
  if (repoSample) ports.push([5174, 'the sample app']);
  for (const [port, what] of ports) {
    if (await free(port)) ok(`Port ${port} is free (${what})`);
    else warn(`Port ${port} is busy (${what})`, 'Something else uses it. The studio takes the next free port.');
  }

  const release = await latest;
  if (release && newer(release, layout.version)) warn(`Saywright ${release} is out (this is ${layout.version})`, 'npx @saywright/studio runs it; a global install updates with npm install -g @saywright/studio@latest.');

  const problems = checks.filter((ch) => ch.status === 'problem').length;
  if (json) {
    const report = { version: layout.version, node: process.versions.node, platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, dataDir: layout.dataDir, studio: running, latest: release, problems, checks };
    console.log(JSON.stringify(report, null, 2));
    return problems ? 1 : 0;
  }
  if (process.platform === 'darwin') console.log(c.dim('\nOn macOS, allow your browser to use the microphone in System Settings → Privacy & Security.'));
  console.log(problems ? c.red(`\n${problems} problem(s) to fix.\n`) : c.green(running ? `\nAll set. The studio is open at ${running}.\n` : `\nAll set. Run ${ctx.startCommand}.\n`));
  return problems ? 1 : 0;
}
