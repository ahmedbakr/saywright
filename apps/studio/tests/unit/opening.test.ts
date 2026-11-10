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

/** A studio whose apps open for real (their changes, sessions and the rest aren't looked at here). */
function opening(startMs = 20_000) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-opening-'));
  const events: { kind: string; step?: string; id?: string }[] = [];
  const manager = new AppManager({
    dataDir,
    emit: (_event, data) => void events.push(data as { kind: string }),
    studio: () => 'http://localhost:7357',
    build: () => ({ sessions: { active: () => null, close: () => undefined }, changes: { previews: () => [] } }) as never,
    startMs,
  });
  return { manager, events, dataDir };
}

/** A small server that answers every page, as any other program on a port would. */
async function otherProgram(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.statusCode = req.url?.startsWith('/__saywright/') ? 404 : 200;
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>Some other program on this port</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

/** A stand-in for a dev server with the plugin: it serves a page, says which folder it serves, and prints its address. */
const DEV_SERVER = `
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/__saywright/info') return res.setHeader('Content-Type', 'application/json'), res.end(JSON.stringify({ root: process.cwd(), version: 1 }));
  res.setHeader('Content-Type', 'text/html');
  res.end('<h1>The app</h1>');
});
server.listen(Number(process.env.FIXED_PORT) || 0, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:' + server.address().port + '/'));
`;

/** An app folder whose Vite config loads the plugin, with `dev.cjs` as its dev server. */
function pluginApp(name: string, installed = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `saywright-${name}-`));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts: { dev: 'node dev.cjs' } }));
  fs.writeFileSync(path.join(root, 'vite.config.js'), "import saywright from '@saywright/vite';\nexport default { plugins: [saywright()] };\n");
  fs.writeFileSync(path.join(root, 'dev.cjs'), DEV_SERVER);
  if (installed) fs.mkdirSync(path.join(root, 'node_modules'));
  return root;
}

describe('an app whose usual port is held by another program', { timeout: 60_000 }, () => {
  it('is started beside it, and never shown as that program', async () => {
    const other = await otherProgram();
    const { manager } = opening();
    try {
      const root = pluginApp('shop');
      const app = manager.link({ name: 'shop', root, framework: 'vite', packageManager: 'npm', start: `"${process.execPath}" dev.cjs`, url: `http://localhost:${other.port}`, connection: 'plugin', notes: [] });
      const ws = await manager.open(app.id);
      expect(new URL(ws.project.url).port).not.toBe(String(other.port));
      expect(await (await fetch(ws.project.url)).text()).toBe('<h1>The app</h1>');
      // Where it runs now is remembered, so the next open goes straight there.
      expect(manager.registry.get(app.id)!.envs[0].url).toBe(new URL(ws.project.url).origin);
    } finally {
      manager.close();
      await other.close();
    }
  });

  it('is still taken for the app when it is the app: its own dev server, started by its owner', async () => {
    const { manager } = opening();
    const root = pluginApp('mine');
    const { spawn } = await import('node:child_process');
    const own = spawn(process.execPath, ['dev.cjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const port = await new Promise<string>((resolve) => own.stdout.on('data', (d: Buffer) => /localhost:(\d+)/.test(String(d)) && resolve(/localhost:(\d+)/.exec(String(d))![1])));
      const app = manager.link({ name: 'mine', root, framework: 'vite', packageManager: 'npm', start: `"${process.execPath}" dev.cjs`, url: `http://localhost:${port}`, connection: 'plugin', notes: [] });
      const ws = await manager.open(app.id);
      expect(new URL(ws.project.url).port).toBe(port);
      expect(manager.runner.running(app.id)).toBe(false);
    } finally {
      own.kill();
      manager.close();
    }
  });

  it('is left as it was for an app the plugin doesn’t connect: nothing says whose server that is', async () => {
    const other = await otherProgram();
    const { manager } = opening();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-plain-'));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'plain', scripts: { dev: 'node never.cjs' } }));
      fs.mkdirSync(path.join(root, 'node_modules'));
      const app = manager.link({ name: 'plain', root, framework: 'vite', packageManager: 'npm', start: 'node never.cjs', url: `http://localhost:${other.port}`, connection: 'proxy', notes: [] });
      const ws = await manager.open(app.id);
      expect(new URL(ws.project.url).port).toBe(String(other.port));
    } finally {
      manager.close();
      await other.close();
    }
  });
});

describe('an app connected with a script tag', { timeout: 60_000 }, () => {
  /** A Next.js app's folder whose layout loads the studio's script from `studio`, running at `port`. */
  const tagged = (name: string, studio: string, port: number) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `saywright-${name}-`));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts: { dev: 'next dev' } }));
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app/layout.tsx'), `export default function Layout({ children }) {\n  return <html><head>{process.env.NODE_ENV === 'development' && <script src="${studio}/saywright.js" defer />}</head><body>{children}</body></html>;\n}\n`);
    return { name, root, framework: 'next' as const, packageManager: 'npm' as const, start: 'next dev', url: `http://localhost:${port}`, connection: 'script' as const, notes: [] };
  };

  it('whose tag names another studio address is shown through the proxy, and its notes say why', async () => {
    const running = await otherProgram();
    const { manager } = opening();
    try {
      const app = manager.link(tagged('portfolio', 'http://localhost:7440', running.port));
      const ws = await manager.open(app.id);
      expect(ws.env.connection).toBe('proxy');
      expect(new URL(ws.frameUrl).port).not.toBe(String(running.port));
      expect(manager.runner.get(app.id).log.join('\n')).toMatch(/app\/layout\.tsx.*http:\/\/localhost:7440.*http:\/\/localhost:7357/);
    } finally {
      manager.close();
      await running.close();
    }
  });

  it('whose tag names this studio is shown as it is', async () => {
    const running = await otherProgram();
    const { manager } = opening();
    try {
      const app = manager.link(tagged('mine', 'http://localhost:7357', running.port));
      const ws = await manager.open(app.id);
      expect(ws.env.connection).toBe('script');
      expect(ws.frameUrl).toBe(`http://localhost:${running.port}`);
    } finally {
      manager.close();
      await running.close();
    }
  });
});
