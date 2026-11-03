#!/usr/bin/env node
// Checks the packed packages the way a person gets them: installed into an empty project from the tarballs (npm
// pack's output in <folder>). `saywright` prints its version, starts, serves its interface and API, and refuses
// other hosts; `@saywright/vite` loads in Node, its protocol module too (with types), and a Vite dev server with
// the plugin serves the bridge. Used by CI on Linux, macOS and Windows.
//
//   node scripts/smoke-package.mjs <folder with saywright-x.y.z.tgz and saywright-vite-x.y.z.tgz>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.');
const tarball = fs.readdirSync(dir).find((f) => /^saywright-\d.*\.tgz$/.test(f));
if (!tarball) throw new Error(`No saywright-*.tgz in ${dir}`);
const pluginTarball = fs.readdirSync(dir).find((f) => /^saywright-vite-\d.*\.tgz$/.test(f));
if (!pluginTarball) throw new Error(`No saywright-vite-*.tgz in ${dir}`);

/**
 * An empty project with these tarballs installed. In the temporary folder by its full name: Windows runners give it as
 * an 8.3 short name (C:\Users\RUNNER~1\…), which Vite's check of what it may serve resolves to the long one, and a
 * project is opened by its real path.
 */
function install(name, ...tarballs) {
  const at = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `${name}-`));
  fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', ...tarballs.map((t) => path.join(dir, t))], { cwd: at, stdio: 'inherit', shell: process.platform === 'win32' });
  if (npm.status !== 0) throw new Error('npm install failed');
  return at;
}

await checkPlugin();

const project = install('saywright-smoke', tarball);
const home = path.join(project, 'home');

const bin = path.join(project, 'node_modules', 'saywright', 'bin', 'saywright.mjs');
const env = { ...process.env, SAYWRIGHT_HOME: home, CI: '1' };
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: project, env, encoding: 'utf8' });

const version = run('--version');
const expected = JSON.parse(fs.readFileSync(path.join(project, 'node_modules', 'saywright', 'package.json'), 'utf8')).version;
if (version.status !== 0 || version.stdout.trim() !== expected) throw new Error(`--version printed “${version.stdout.trim()}” (${version.stderr})`);
console.log(`✓ saywright --version: ${expected}`);

const port = 7399;
const server = spawn(process.execPath, [bin, '--port', String(port), '--no-open'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const base = `http://localhost:${port}`;
const check = async (what, test) => {
  try {
    await test();
    console.log(`✓ ${what}`);
  } catch (err) {
    server.kill();
    console.error(`✗ ${what}: ${err.message}\n--- studio output ---\n${log}`);
    process.exit(1);
  }
};

await check('starts and answers', async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.ok && (await res.json()).version === expected) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no answer from /api/status in 30 s');
});
await check('serves the interface, apart from the app in its frame', async () => {
  const page = await fetch(`${base}/`);
  if (page.headers.get('origin-agent-cluster') !== '?1') throw new Error('the page doesn’t ask for a process of its own (Origin-Agent-Cluster)');
  const html = await page.text();
  if (!html.includes('<title>Saywright</title>')) throw new Error('no studio page');
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (!script || !(await fetch(base + script)).ok) throw new Error(`the page's script ${script} doesn't load`);
});
await check('serves the script that makes apps pointable, and the accessibility checks', async () => {
  for (const p of ['/saywright.js', '/axe.min.js']) {
    const res = await fetch(base + p);
    if (!res.ok || !/javascript/.test(res.headers.get('content-type') ?? '')) throw new Error(`${p}: ${res.status}`);
  }
});
await check('refuses requests for other hosts (DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: `attacker.example:${port}` } }, (res) => resolve(res.statusCode)).on('error', reject);
  });
  if (status !== 403) throw new Error(`answered ${status}`);
});
await check('keeps its data where SAYWRIGHT_HOME says', async () => {
  if (!fs.existsSync(path.join(home, 'server.json'))) throw new Error(`nothing in ${home}`);
});

server.kill();
console.log('✓ the packed package works');

/** The plugin as an app gets it, with Vite (its peer) installed beside it. */
async function checkPlugin() {
  const app = install('saywright-vite-smoke', pluginTarball);
  const node = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: app, encoding: 'utf8' });
  const step = (what, r) => {
    if (r.status !== 0) {
      console.error(`✗ ${what}\n${r.stdout}${r.stderr}`);
      process.exit(1);
    }
    console.log(`✓ ${what}`);
  };
  step('@saywright/vite loads in Node and makes a Vite plugin', node(`import saywright from '@saywright/vite'; if (saywright().name !== 'saywright') throw new Error('not the plugin');`));
  step(
    '@saywright/vite/protocol loads in Node, with its types',
    node(`import { PROTOCOL_VERSION, jsString } from '@saywright/vite/protocol'; import fs from 'node:fs';
      if (typeof PROTOCOL_VERSION !== 'number' || jsString('a\\nb') !== "'a\\\\nb'") throw new Error('unexpected protocol module');
      if (!fs.existsSync('node_modules/@saywright/vite/dist/protocol.d.ts') || !fs.existsSync('node_modules/@saywright/vite/types/index.d.ts')) throw new Error('types missing');`),
  );
  step('the studio’s own modules stay out of the package', node(`try { await import('@saywright/vite/client'); } catch (e) { if (e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(0); throw e; } throw new Error('@saywright/vite/client is exported');`));
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>');
  step(
    'a Vite dev server with the plugin serves the bridge and says where it is',
    node(`import { createServer } from 'vite'; import saywright from '@saywright/vite';
      const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', plugins: [saywright()], server: { port: 0 } });
      await server.listen();
      const base = 'http://localhost:' + server.httpServer.address().port;
      try {
        const page = await fetch(base + '/');
        const html = await page.text();
        if (!html.includes('/__saywright/bridge.js')) throw new Error('no bridge in the page (' + page.status + '): ' + html.slice(0, 400));
        const bridge = await fetch(base + '/__saywright/bridge.js');
        if (!bridge.ok || !/javascript/.test(bridge.headers.get('content-type') ?? '') || (await bridge.text()).length < 10000) throw new Error('no bridge script');
        const info = await (await fetch(base + '/__saywright/info')).json();
        if (typeof info.version !== 'number') throw new Error('no protocol version in /__saywright/info');
      } finally {
        await server.close();
      }`),
  );
}
