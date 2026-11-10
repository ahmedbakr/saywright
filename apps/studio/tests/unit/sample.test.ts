/**
 * “Try the sample shop”, the first thing a newcomer clicks: the shop is copied out of the package, what it needs is
 * installed, and it opens, in that one click. When installing fails, the answer says so and the shop stays linked,
 * so the next try picks up from there.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

/** A `pnpm` that "installs" (makes node_modules) or fails, ahead of the real programs on PATH. */
function packageManager(works: boolean): () => void {
  const saved = process.env.PATH;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-pm-'));
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'pnpm.cmd'), works ? '@echo off\r\nmkdir node_modules\r\necho added 12 packages\r\n' : '@echo off\r\necho ERR_PNPM_FETCH registry.npmjs.org unreachable\r\nexit /b 1\r\n');
  else fs.writeFileSync(path.join(bin, 'pnpm'), works ? '#!/bin/sh\n/bin/mkdir -p node_modules\necho "added 12 packages"\n' : '#!/bin/sh\necho "ERR_PNPM_FETCH registry.npmjs.org unreachable"\nexit 1\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  return () => void (process.env.PATH = saved);
}

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function studio() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-sample-'));
  const events: { kind: string; id?: string; step?: string }[] = [];
  const emit = (_event: string, data: unknown) => void events.push(data as { kind: string });
  const apps = new AppManager({ dataDir, emit, studio: () => 'http://localhost:7357', build: () => ({ sessions: { active: () => null, close: () => undefined }, changes: { previews: () => [] } }) as never, startMs: 30_000 });
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
    cleanup.push(packageManager(true));
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
    cleanup.push(packageManager(false));
    const { apps, post } = await studio();
    const res = await post('/apps/sample');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('install-failed');
    expect(body.error).toMatch(/^The sample shop’s dependencies couldn’t be installed \(pnpm install\)\. Check your connection and try again\.\n.*registry\.npmjs\.org unreachable/);
    expect(apps.registry.list().some((a) => a.sample)).toBe(true);
    expect(apps.active()).toBeNull();
  });
});
