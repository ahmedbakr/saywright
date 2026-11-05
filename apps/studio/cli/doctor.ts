/** `saywright doctor`: check what the studio needs, and say how to fix what's missing. */
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
import { SpeechService } from '../server/speech/service.ts';
import { runningStudio } from './connect.ts';
import type { CliContext } from './index.ts';
import { c, ok, warn } from './term.ts';

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

/** A program's output, or null when it isn't installed. */
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  return r.error ? null : r;
};

export async function doctor(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(`\n${c.bold('saywright doctor')}: check what the studio needs, and how to fix what's missing\n`);
    return 0;
  }
  const { layout } = ctx;
  let problems = 0;
  const bad = (msg: string, fix?: string) => {
    problems++;
    console.log(`${c.red('✗')} ${msg}${fix ? `\n  ${c.dim(fix)}` : ''}`);
  };
  console.log(c.bold('\nSaywright doctor\n'));

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 20 || (major === 20 && minor >= 19)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old`, 'Install Node 22 or newer from https://nodejs.org.');

  if (fs.existsSync(layout.bridgeFile)) ok('The script that makes apps pointable is built');
  else bad('The script that makes apps pointable isn’t built', ctx.clientDir ? 'Reinstall Saywright (npx @saywright/studio@latest).' : 'Run npm run build:plugin.');
  if (ctx.clientDir && !fs.existsSync(path.join(ctx.clientDir, 'index.html'))) bad('The studio’s interface isn’t built', 'Reinstall Saywright (npx @saywright/studio@latest).');

  if (browserSpeechReady(layout.dataDir)) ok('On-device voice model');
  else warn('On-device voice model not downloaded: voice uses the browser’s recogniser alone', `Run ${ctx.clientDir ? 'npx @saywright/studio setup' : 'npm run setup'} to download it once (28 MB).`);

  const speech = new SpeechService(speechDir(layout), layout.speechWorker, () => undefined).status();
  if (speech.runtime === 'missing') warn('The speech engine can’t run on this computer', 'Narration is still recorded; voice uses the browser’s recogniser.');
  else {
    const have = speech.models.filter((m) => m.installed);
    const missing = [!speech.active.ar && 'Arabic', !speech.active.en && 'English'].filter(Boolean);
    if (!missing.length) ok(`Speech models: ${have.map((m) => m.label).join(', ')}`);
    else warn(`No speech model for ${missing.join(' or ')}`, `Run ${ctx.clientDir ? 'npx @saywright/studio setup' : 'npm run setup'}, or install one from Settings → Voice in the studio.`);
  }

  // AI: a plan through its official app, an API key, or a model on this computer. Any one is enough.
  const envLocal = path.join(layout.envDir, '.env.local');
  const envText = fs.existsSync(envLocal) ? fs.readFileSync(envLocal, 'utf8') : '';
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
  if (run('gemini', ['--version'])?.status === 0) ai.push('Gemini CLI');
  const profileDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'anthropic');
  if (keySet('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN') || (fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0)) ai.push('an Anthropic API key');
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

  // A studio running now says where it listens (it may have moved off its usual port): that is where it is.
  const running = runningStudio(layout.dataDir);
  if (running) ok(`The studio is running at ${running}`);
  const ports: Array<[number, string]> = running ? [] : [[STUDIO_PORT, 'the studio']];
  if (repoSample) ports.push([5174, 'the sample app']);
  for (const [port, what] of ports) {
    if (await free(port)) ok(`Port ${port} is free (${what})`);
    else warn(`Port ${port} is busy (${what})`, 'Something else uses it. The studio takes the next free port.');
  }

  if (process.platform === 'darwin') console.log(c.dim('\nOn macOS, allow your browser to use the microphone in System Settings → Privacy & Security.'));
  console.log(problems ? c.red(`\n${problems} problem(s) to fix.\n`) : c.green(running ? `\nAll set. The studio is open at ${running}.\n` : `\nAll set. Run ${ctx.startCommand}.\n`));
  return problems ? 1 : 0;
}
