/**
 * “Try the sample shop”, the first thing a newcomer clicks: the shop is copied out of the package, what it needs is
 * installed, and it opens, in that one click. When installing fails, the answer says so and the shop stays linked,
 * so the next try picks up from there. The copy is the studio's own, so a studio updated since brings its plugin up
 * to its own before starting it; nobody else's app is changed that way.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeFolder } from '../../server/apps/detect';
import { AppManager } from '../../server/apps/manager';
import { appRoutes } from '../../server/apps/routes';
import { Router } from '../../server/http';
import { tree } from './helpers';

/** A stand-in for the shop's dev server: a page, the folder it serves (as the plugin says it), its address printed. */
const DEV_SERVER = `
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/__saywright/info') return res.setHeader('Content-Type', 'application/json'), res.end(JSON.stringify({ root: process.cwd(), version: 1 }));
  res.setHeader('Content-Type', 'text/html');
  res.end('<h1>Tidewell</h1>');
});
server.listen(0, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:' + server.address().port + '/'));
`;

/** The shop as the package ships it: no dependencies installed, pnpm as its package manager (stood in for below). */
const shipped = () =>
  tree({
    'package.json': { name: 'shop', scripts: { dev: 'node dev.cjs' } },
    'pnpm-lock.yaml': '',
    'vite.config.js': "import saywright from '@saywright/vite';\nexport default { plugins: [saywright()] };\n",
    'dev.cjs': DEV_SERVER,
    'index.html': '<!doctype html><title>Tidewell</title>',
  });

/** What the stand-in does: `install` makes node_modules, `add -D name@version` puts that version of the package in it. */
const PACKAGE_MANAGER = `
const fs = require('fs');
const [verb, , spec] = process.argv.slice(2);
fs.appendFileSync('pm.log', process.argv.slice(2).join(' ') + '\\n');
const how = process.argv[1].endsWith('fails.cjs') ? 'fails' : process.argv[1].endsWith('hangs.cjs') ? 'hangs' : 'works';
if (how === 'fails') {
  console.log('ERR_PNPM_FETCH registry.npmjs.org unreachable');
  process.exit(1);
}
if (how === 'hangs') setTimeout(() => process.exit(1), 60000);
else {
  if (verb === 'add') {
    const at = spec.lastIndexOf('@');
    fs.mkdirSync('node_modules/' + spec.slice(0, at), { recursive: true });
    fs.writeFileSync('node_modules/' + spec.slice(0, at) + '/package.json', JSON.stringify({ name: spec.slice(0, at), version: spec.slice(at + 1) }));
  } else fs.mkdirSync('node_modules', { recursive: true });
  console.log('added 12 packages');
}
`;

/** A `pnpm` that installs, fails, or never finishes, ahead of the real programs on PATH. */
function packageManager(how: 'works' | 'fails' | 'hangs'): () => void {
  const saved = process.env.PATH;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-pm-'));
  const script = path.join(bin, `${how}.cjs`);
  fs.writeFileSync(script, PACKAGE_MANAGER);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'pnpm.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  return () => void (process.env.PATH = saved);
}

/** What the stand-in was asked, a line each time. */
const asked = (root: string): string[] => (fs.existsSync(path.join(root, 'pm.log')) ? fs.readFileSync(path.join(root, 'pm.log'), 'utf8').trim().split('\n') : []);

/** The shop as an earlier release copied and installed it (with that release's plugin), and the plugin that is there now. */
const PLUGIN = 'node_modules/@saywright/vite/package.json';
function copied(root: string, plugin: string): void {
  fs.cpSync(shipped(), root, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, PLUGIN)), { recursive: true });
  fs.writeFileSync(path.join(root, PLUGIN), JSON.stringify({ name: '@saywright/vite', version: plugin }));
}
const pluginIn = (root: string): string => (JSON.parse(fs.readFileSync(path.join(root, PLUGIN), 'utf8')) as { version: string }).version;

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function studio(version = '0.3.1') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-sample-'));
  const events: { kind: string; id?: string; step?: string }[] = [];
  const emit = (_event: string, data: unknown) => void events.push(data as { kind: string });
  const apps = new AppManager({ dataDir, emit, studio: () => 'http://localhost:7357', build: () => ({ sessions: { active: () => null, close: () => undefined }, changes: { previews: () => [] } }) as never, startMs: 30_000, version });
  const root = path.join(dataDir, 'sample-shop');
  const router = new Router();
  appRoutes(router, { apps, emit, sample: { source: shipped(), root } });
  const mw = router.middleware('/api');
  const server = http.createServer((req, res) => void mw(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(() => apps.close(), () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
  const post = (p: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return { apps, events, root, post };
}

describe('the sample shop', { timeout: 60_000 }, () => {
  it('is copied, installed and opened by the one request the welcome screen makes', async () => {
    cleanup.push(packageManager('works'));
    const { apps, events, root, post } = await studio();
    const res = await post('/apps/sample');
    const state = (await res.json()) as { active: string; apps: { id: string; sample?: boolean; name: string }[]; error?: string };
    expect(state.error).toBeUndefined();
    expect(res.status).toBe(200);
    const shop = state.apps.find((a) => a.sample)!;
    expect(shop.name).toBe('Tidewell (sample shop)');
    expect(state.active).toBe(shop.id);
    expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(true);
    // What it is doing is said under the shop's own id, so the screen shows it (and its output) while it installs.
    expect(events.find((e) => e.kind === 'opening' && e.step?.startsWith('Installing the sample shop'))?.id).toBe(shop.id);
    expect(await (await fetch(apps.active()!.project.url)).text()).toBe('<h1>Tidewell</h1>');
  });

  it('says why when it can’t be installed, and stays linked for the next try', async () => {
    cleanup.push(packageManager('fails'));
    const { apps, post } = await studio();
    const res = await post('/apps/sample');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('install-failed');
    expect(body.error).toMatch(/^The sample shop’s dependencies couldn’t be installed \(pnpm install\)\. Check your connection and try again\.\n.*registry\.npmjs\.org unreachable/);
    expect(apps.registry.list().some((a) => a.sample)).toBe(true);
    expect(apps.active()).toBeNull();
  });

  const UPDATING = 'Updating the sample shop’s Saywright plugin';

  it('has its plugin brought up to the studio’s before it is started, by a studio updated since it was copied', async () => {
    cleanup.push(packageManager('works'));
    const { apps, events, root, post } = await studio('0.3.1');
    copied(root, '0.3.0');
    expect((await post('/apps/sample')).status).toBe(200);
    const shop = apps.registry.list().find((a) => a.sample)!;
    expect(asked(root)).toEqual(['add -D @saywright/vite@0.3.1']);
    expect(pluginIn(root)).toBe('0.3.1');
    // Said while it runs, under the shop's id; then the shop is started, with the plugin it has now.
    const steps = events.filter((e) => e.kind === 'opening' && e.id === shop.id).map((e) => e.step);
    expect(steps.slice(steps.indexOf(UPDATING))).toEqual([UPDATING, 'Starting']);
    expect(apps.active()!.app.id).toBe(shop.id);
    // Current now: started again, nothing more is asked of the package manager.
    await apps.runner.stop(shop.id);
    expect((await post('/apps/sample')).status).toBe(200);
    expect(asked(root)).toHaveLength(1);
  });

  it('opens as it is when its plugin can’t be updated, and that is tried once each time the studio runs', async () => {
    cleanup.push(packageManager('fails'));
    const { apps, root, post } = await studio('0.3.1');
    copied(root, '0.3.0');
    expect((await post('/apps/sample')).status).toBe(200);
    const shop = apps.registry.list().find((a) => a.sample)!;
    expect(apps.active()!.app.id).toBe(shop.id);
    expect(pluginIn(root)).toBe('0.3.0');
    await apps.runner.stop(shop.id);
    expect((await post('/apps/sample')).status).toBe(200);
    expect(asked(root)).toEqual(['add -D @saywright/vite@0.3.1']);
  });

  it('isn’t started when opening it is cancelled while its plugin is updated', async () => {
    cleanup.push(packageManager('hangs'));
    const { apps, events, root, post } = await studio('0.3.1');
    copied(root, '0.3.0');
    const answer = post('/apps/sample');
    await vi.waitFor(() => expect(asked(root)).toHaveLength(1), { timeout: 20_000 });
    const shop = apps.registry.list().find((a) => a.sample)!;
    // What Cancel does while an app opens.
    await apps.runner.stop(shop.id);
    expect((await answer).status).toBe(502);
    expect(apps.active()).toBeNull();
    expect(apps.runner.get(shop.id).status).toBe('stopped');
    expect(events.filter((e) => e.kind === 'opening').at(-1)!.step).toBe(UPDATING);
    // What was cancelled wasn't tried: opening the shop again starts over.
    const again = post('/apps/sample');
    await vi.waitFor(() => expect(asked(root)).toHaveLength(2), { timeout: 20_000 });
    await apps.runner.stop(shop.id);
    expect((await again).status).toBe(502);
  });

  it('leaves a current plugin alone, and the plugin of anyone’s own app: that one is theirs to update', async () => {
    cleanup.push(packageManager('works'));
    const { apps, root, post } = await studio('0.3.1');
    copied(root, '0.3.1');
    expect((await post('/apps/sample')).status).toBe(200);
    expect(asked(root)).toEqual([]);
    // Someone's own app, with the plugin of an earlier release: opened as it is (the app itself says what it needs).
    const own = path.join(path.dirname(root), 'own-app');
    copied(own, '0.2.3');
    const app = apps.link({ ...probeFolder(own), connection: 'plugin' }, { url: 'http://localhost:5176', start: 'npm run dev' });
    await apps.open(app.id);
    expect(apps.active()!.app.id).toBe(app.id);
    expect(asked(own)).toEqual([]);
    expect(pluginIn(own)).toBe('0.2.3');
  });
});
