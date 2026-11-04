/**
 * Opening a linked app the studio starts itself: when its dev server doesn't come up, the studio says why and what to
 * do, and a server that never answered isn't left running.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppManager } from '../../server/apps/manager';
import { programs } from './helpers';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-opening-'));
const apps = new AppManager({
  dataDir: data,
  emit: () => undefined,
  studio: () => 'http://localhost:7357',
  build: () => {
    throw new Error('not opened in these tests');
  },
  startMs: 6000,
});
afterAll(() => apps.close());

let path$: { restore: () => void } | null = null;
afterEach(() => {
  path$?.restore();
  path$ = null;
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** An installed app whose dev command is `start`, linked to the studio. */
async function linked(name: string, start: string, files: Record<string, string> = {}): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `saywright-${name}-`));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts: { dev: start } }));
  fs.mkdirSync(path.join(root, 'node_modules'));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
  return apps.link({ name, root, framework: 'vite', packageManager: 'npm', start, url: `http://localhost:${await closedPort()}`, connection: 'proxy', notes: [] }).id;
}

// These start real processes: on a busy computer (tests run side by side) a child can take seconds to start.
describe('an app that doesn’t start', { timeout: 60_000 }, () => {
  it('names a package manager this computer hasn’t got', async () => {
    path$ = programs();
    const id = await linked('admin', 'pnpm run dev');
    await expect(apps.open(id)).rejects.toThrow(/^admin didn’t start: “pnpm” isn’t installed on this computer\. Install it, or change its dev command/);
  });

  it('names a program its dependencies should have brought', async () => {
    path$ = programs();
    const id = await linked('blog', 'astro dev');
    await expect(apps.open(id)).rejects.toThrow(/^blog didn’t start: “astro” isn’t installed\. Install its dependencies/);
  });

  it('says where it said it was when nothing answered there, and stops it', async () => {
    const port = await closedPort();
    const id = await linked('quiet', `"${process.execPath}" never.mjs`, { 'never.mjs': `console.log('  ➜  Local:   http://localhost:${port}/ (pid ' + process.pid + ')');\nsetInterval(() => {}, 1000);\n` });
    await expect(apps.open(id)).rejects.toThrow(new RegExp(`^quiet didn’t start: it said it was at http://localhost:${port}/, but nothing answered there within 6 seconds, so the studio stopped it\\.`));
    const run = apps.runner.get(id);
    expect(run.status).toBe('stopped');
    const pid = Number(/\(pid (\d+)\)/.exec(run.log.join('\n'))![1]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('says when its port is taken by another program, and what to do', async () => {
    const busy = http.createServer();
    await new Promise<void>((resolve) => busy.listen(0, '0.0.0.0', () => resolve()));
    const { port } = busy.address() as AddressInfo;
    try {
      // Like `next dev -p <port>`: a port given outright isn't moved, the server exits.
      const id = await linked('admin', `"${process.execPath}" -e "require('http').createServer().listen(${port}, '0.0.0.0')"`);
      await expect(apps.open(id)).rejects.toThrow(new RegExp(`^admin didn’t start: port ${port} is taken by another program\\. Close it, or give the app another port in its dev command`));
    } finally {
      busy.close();
    }
  });

  it('says when its command finished without starting a server', async () => {
    const id = await linked('script', `"${process.execPath}" -e "console.log('built')"`);
    await expect(apps.open(id)).rejects.toThrow(/^script didn’t start: its dev command finished without starting a server/);
    expect(apps.runner.get(id).status).toBe('stopped');
  });

  it('points at its output when it stopped with an error', async () => {
    // A port it moved off on the way (Vite) isn't the reason.
    const id = await linked('api', `"${process.execPath}" -e "console.log('Port 5173 is in use, trying another one...'); console.error('Error: DATABASE_URL is not set'); process.exit(1)"`);
    await expect(apps.open(id)).rejects.toThrow(/^api didn’t start: its dev command stopped with exit code 1\. Its output says why\.\n[\s\S]*DATABASE_URL is not set/);
    expect(apps.runner.get(id).status).toBe('crashed');
  });
});

/** A studio that opens apps for real (a workspace without sessions), with its proxy on ports of its own. */
const opener = () =>
  new AppManager({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-opening-')),
    emit: () => undefined,
    studio: () => 'http://localhost:7357',
    build: () => ({ changes: {}, metrics: {}, mapper: {}, sessions: { close: () => undefined, active: () => null, store: { has: () => false } } }) as never,
    proxyPort: 5700 + Math.floor(Math.random() * 200),
    startMs: 20_000,
  });

describe('an app that moved to another port', { timeout: 60_000 }, () => {
  it('is followed, and where it runs now is remembered, though its plugin didn’t answer this time', async () => {
    const studio = opener();
    try {
      const [usual, now] = [await closedPort(), await closedPort()];
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-moved-'));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'moved' }));
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'server.mjs'), `import http from 'node:http';\nhttp.createServer((q, s) => s.end('<html><head></head><body>moved</body></html>')).listen(${now}, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:${now}/'));\n`);
      const app = studio.link({ name: 'moved', root, framework: 'vite', packageManager: 'npm', start: `"${process.execPath}" server.mjs`, url: `http://localhost:${usual}`, connection: 'plugin', notes: [] });
      const ws = await studio.open(app.id);
      expect(ws.project.url).toBe(`http://localhost:${now}`);
      expect(studio.registry.get(app.id)!.envs[0]).toMatchObject({ url: `http://localhost:${now}`, connection: 'proxy' });
    } finally {
      studio.close();
    }
  });
});

describe('an app with the Vite plugin', { timeout: 60_000 }, () => {
  it('is shown through its plugin, though the plugin is slow to answer just after starting', async () => {
    const studio = opener();
    try {
      const port = await closedPort();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-plugin-'));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'busy' }));
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'vite.config.ts'), `import saywright from '@saywright/vite';\nexport default { plugins: [saywright()] };\n`);
      // Like a dev server type-checking as it starts: its plugin answers after 6 seconds.
      fs.writeFileSync(path.join(root, 'server.mjs'), `import http from 'node:http';\nhttp.createServer((q, s) => q.url === '/__saywright/info' ? setTimeout(() => { s.setHeader('content-type', 'application/json'); s.end('{}'); }, 6000) : s.end('<html><head></head><body>busy</body></html>')).listen(${port}, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:${port}/'));\n`);
      const app = studio.link({ name: 'busy', root, framework: 'vite', packageManager: 'npm', start: `"${process.execPath}" server.mjs`, url: `http://localhost:${port}`, connection: 'plugin', notes: [] });
      const ws = await studio.open(app.id);
      expect(ws.env.connection).toBe('plugin');
      expect(ws.frameUrl).toBe(`http://localhost:${port}`);
    } finally {
      studio.close();
    }
  });
});

describe('a studio that restarts while an app records', () => {
  it('sets that app up at once, without opening it, so the page recording it finds the studio again', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-recording-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"recorded"}');
    const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-quiet-'));
    fs.writeFileSync(path.join(quiet, 'package.json'), '{"name":"quiet"}');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-opening-'));
    const built: string[] = [];
    const make = () =>
      new AppManager({
        dataDir,
        emit: () => undefined,
        studio: () => 'http://localhost:7357',
        build: (project) => {
          built.push(project.root);
          return { changes: {}, metrics: {}, mapper: {}, sessions: { close: () => undefined, active: () => null, store: { has: (id: string) => id === '20261104-101500-abcd' } } } as never;
        },
      });
    const first = make();
    const recorded = first.link({ name: 'recorded', root, framework: 'vite', packageManager: 'npm', start: null, url: 'http://localhost:5190', connection: 'plugin', notes: [] });
    first.link({ name: 'quiet', root: quiet, framework: 'vite', packageManager: 'npm', start: null, url: 'http://localhost:5191', connection: 'plugin', notes: [] });
    // Its newest session was still recording when the studio stopped.
    const session = path.join(root, '.saywright/sessions/20261104-101500-abcd');
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, 'session.json'), JSON.stringify({ id: '20261104-101500-abcd', status: 'recording' }));
    first.close();

    const studio = make();
    studio.restoreRecordings();
    try {
      expect(built).toEqual([root]);
      expect(studio.active()).toBeNull();
      expect(studio.forSession('20261104-101500-abcd').app.id).toBe(recorded.id);
    } finally {
      studio.close();
    }
  });
});
