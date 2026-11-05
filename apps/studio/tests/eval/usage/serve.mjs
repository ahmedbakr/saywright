// Starts the studio (its sources) and every project of the usage benchmark, each from a copy in tests/.usage-work,
// so the projects' own files never change; the studio's data goes to tests/.usage-home. A project's manifest
// (projects/<name>/usage.json) says where its sources are, whether it needs `npm install`, and whether it has a dev
// server (Vite) or is a folder the studio serves itself. Writes where everything runs to .usage-work/projects.json.
//
// No AI unless EVAL_AI=real: every AI key is taken out of the studio's environment, and every AI it would find on this
// computer (a plan's app, a model served locally) is turned off, so a run costs nothing and uses no AI at all.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { ensurePlugin } from '../../../../../scripts/lib/plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(here, '../../..');
const PROJECTS = path.join(here, 'projects');
const WORK = path.join(STUDIO, 'tests/.usage-work');
const STUDIO_PORT = Number(process.env.EVAL_STUDIO_PORT) || 5473;
const FIRST_PORT = Number(process.env.EVAL_APP_PORT) || 5501;
const only = (process.env.EVAL_PROJECTS ?? '').split(',').filter(Boolean);

if (!ensurePlugin()) process.exit(1);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.SAYWRIGHT_HOME = path.join(STUDIO, 'tests/.usage-home');
fs.rmSync(process.env.SAYWRIGHT_HOME, { recursive: true, force: true });
delete process.env.SAYWRIGHT_AI;
const offline = process.env.EVAL_AI !== 'real';
if (offline) {
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|OPENROUTER|GROQ|DEEPSEEK|MISTRAL|XAI)_/.test(k)) delete process.env[k];
  // What the studio finds by itself (server/ai/connections.ts: a plan's app, a key in .env.local or a CLI profile, a
  // local server), turned off as a person would in Settings → AI.
  fs.mkdirSync(process.env.SAYWRIGHT_HOME, { recursive: true });
  const off = ['claude-code', 'codex', 'gemini-cli', 'anthropic', 'openai', 'gemini', 'ollama', 'lmstudio'];
  fs.writeFileSync(path.join(process.env.SAYWRIGHT_HOME, 'ai.json'), JSON.stringify({ off }));
}

const servers = [];
const projects = [];
let port = FIRST_PORT;
for (const name of fs.readdirSync(PROJECTS).filter((n) => !only.length || only.includes(n)).sort()) {
  const dir = path.join(PROJECTS, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
  const root = path.join(WORK, name);
  const source = path.resolve(dir, manifest.source ?? '.');
  // Without what an earlier use left: its sessions, test results and written tests.
  fs.cpSync(source, root, { recursive: true, filter: (p) => !/[\\/](node_modules|dist|test-results|\.saywright)$|[\\/]tests[\\/]saywright$/.test(p) });
  // The copy lives at another depth: a tsconfig that extends a shared one by a relative path points back at it.
  const tsconfig = path.join(root, 'tsconfig.json');
  if (fs.existsSync(tsconfig)) {
    const text = fs.readFileSync(tsconfig, 'utf8');
    const from = /"extends":\s*"(\.[^"]+)"/.exec(text)?.[1];
    if (from) fs.writeFileSync(tsconfig, text.replace(/"extends":\s*"[^"]+"/, `"extends": "${path.relative(root, path.resolve(source, from)).split(path.sep).join('/')}"`));
  }
  if (manifest.install) {
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`${name}: npm install failed`);
  }
  let url = null;
  if (manifest.server !== 'none') {
    const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'warn', clearScreen: false });
    await server.listen();
    servers.push(server);
    url = `http://localhost:${port}/`;
    port++;
  }
  projects.push({ name, root, url, manifest });
}
fs.writeFileSync(path.join(WORK, 'projects.json'), JSON.stringify(projects, null, 2));

const studio = await createServer({ root: STUDIO, configFile: path.join(STUDIO, 'vite.config.ts'), server: { port: STUDIO_PORT, strictPort: true }, logLevel: 'warn', clearScreen: false });
await studio.listen();

const stop = async (code = 0) => {
  await Promise.allSettled([studio.close(), ...servers.map((s) => s.close())]);
  process.exit(code);
};
if (offline) {
  // And checked: a run that says it has no AI has none the studio could use.
  const { connections } = await (await fetch(`http://localhost:${STUDIO_PORT}/api/ai?refresh=1`)).json();
  const usable = connections.filter((c) => !c.disabled && c.status === 'ready');
  if (usable.length) {
    console.error(`usage: no AI was asked for, but the studio could use ${usable.map((c) => c.label).join(', ')}`);
    await stop(1);
  }
}
console.log(`usage: studio on http://localhost:${STUDIO_PORT} (${offline ? 'no AI' : 'your AI'}), ${projects.length} projects`);

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
