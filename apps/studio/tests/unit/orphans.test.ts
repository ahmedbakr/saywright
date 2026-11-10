/**
 * What the studio starts, it stops: on Ctrl+C, when its terminal is closed and when it crashes; and what a studio
 * that ended anyway left running, the next one stops, as long as it is still what was started. Nothing else is
 * signalled.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinkedApp } from '../../shared/apps';
import { AppRunner } from '../../server/apps/runner';
import { keepStartedIn, stopLeftovers } from '../../server/apps/started';
import { tree } from './helpers';

const ROOT = path.resolve(__dirname, '../../../..');
const KEEP = `setInterval(() => {}, 1000);\nconsole.log('ready');\n`;
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (check()) return true;
  return check();
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

describe.skipIf(process.platform === 'win32')('dev servers left running', () => {
  it('are written down while they run, and the next studio stops them', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-started-'));
    keepStartedIn(data);
    const dir = tree({ 'keep.js': KEEP });
    const runner = new AppRunner(() => undefined);
    await runner.start({ id: 'keep', root: dir, start: 'node keep.js', framework: 'other' } as unknown as LinkedApp);
    const file = path.join(data, 'started.json');
    await until(() => fs.existsSync(file));
    const [entry] = JSON.parse(fs.readFileSync(file, 'utf8')) as { pgid: number; command: string; cwd: string; studio: number }[];
    cleanup.push(() => groupAlive(entry.pgid) && process.kill(-entry.pgid, 'SIGKILL'));
    expect(entry).toMatchObject({ command: 'node keep.js', studio: process.pid });
    expect(groupAlive(entry.pgid)).toBe(true);
    // The studio that started it is gone (as after a closed terminal): the next one stops it.
    fs.writeFileSync(file, JSON.stringify([{ ...entry, studio: 2 ** 22 + 12345 }]));
    expect(await stopLeftovers()).toBe(1);
    expect(await until(() => !groupAlive(entry.pgid))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);

  it('never signals a group that isn’t what was started, nor one another running studio started', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-started-'));
    keepStartedIn(data);
    const dir = tree({ 'keep.js': KEEP });
    const other: ChildProcess = spawn('node keep.js', { cwd: dir, shell: true, detached: true, stdio: 'ignore' });
    const pgid = other.pid!;
    cleanup.push(() => groupAlive(pgid) && process.kill(-pgid, 'SIGKILL'));
    await until(() => groupAlive(pgid));
    const file = path.join(data, 'started.json');
    // Its number, written down for another command, or for this command in another folder: left alone.
    fs.writeFileSync(file, JSON.stringify([{ pgid, command: 'npm run dev', cwd: dir, studio: 2 ** 22 + 12345 }]));
    expect(await stopLeftovers()).toBe(0);
    fs.writeFileSync(file, JSON.stringify([{ pgid, command: 'node keep.js', cwd: os.tmpdir() + '/elsewhere', studio: 2 ** 22 + 12345 }]));
    expect(await stopLeftovers()).toBe(0);
    expect(groupAlive(pgid)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // Started by a studio that still runs (here, the process that runs these tests' parent): its own.
    const theirs = [{ pgid, command: 'node keep.js', cwd: dir, studio: process.ppid }];
    fs.writeFileSync(file, JSON.stringify(theirs));
    expect(await stopLeftovers()).toBe(0);
    expect(groupAlive(pgid)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(theirs);
  }, 30_000);

  it('a studio whose terminal is closed stops the dev server it started', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-hup-'));
    const client = tree({ 'index.html': '<!doctype html><title>Studio</title>' });
    const app = tree({
      'package.json': { name: 'hup-app', scripts: { dev: 'node server.js' } },
      'node_modules/.package-lock.json': '{}',
      'server.js': `const s = require('http').createServer((q, r) => r.end('<!doctype html><title>hup</title>'));\ns.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + s.address().port + '/'));\n`,
    });
    const port = 7512;
    const harness = `
      import { runnerImport } from 'vite';
      import path from 'node:path';
      const S = path.resolve('apps/studio');
      const { module: m } = await runnerImport(path.join(S, 'cli/index.ts'), { configFile: false, logLevel: 'silent', root: S });
      process.exitCode = await m.main(['--port', '${port}', '--no-open'], { layout: { ...m.repoLayout(process.cwd()), dataDir: ${JSON.stringify(home)}, envDir: ${JSON.stringify(home)} }, clientDir: ${JSON.stringify(client)}, pluginSpec: 'x', startCommand: 'x' });
    `;
    const studio = spawn(process.execPath, ['--input-type=module', '-e', harness], { cwd: ROOT, env: { ...process.env, SAYWRIGHT_AI: 'fake' }, stdio: 'ignore' });
    cleanup.push(() => studio.exitCode === null && studio.kill('SIGKILL'));
    const api = async (route: string, body?: unknown) => (await fetch(`http://localhost:${port}/api${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json() as Promise<Record<string, any>>;
    expect(await until(() => fs.existsSync(path.join(home, 'server.json')), 30_000)).toBe(true);
    const { probe } = await api('/apps/probe', { folder: app });
    const linked = await api('/apps', { probe, start: 'npm run dev', open: true });
    expect(linked.error).toBeUndefined();
    const file = path.join(home, 'started.json');
    expect(await until(() => fs.existsSync(file))).toBe(true);
    const [entry] = JSON.parse(fs.readFileSync(file, 'utf8')) as { pgid: number }[];
    cleanup.push(() => groupAlive(entry.pgid) && process.kill(-entry.pgid, 'SIGKILL'));
    expect(groupAlive(entry.pgid)).toBe(true);
    const exited = new Promise<number | null>((resolve) => studio.on('exit', (code) => resolve(code)));
    studio.kill('SIGHUP');
    expect(await exited).toBe(129);
    expect(await until(() => !groupAlive(entry.pgid), 6000)).toBe(true);
    expect(fs.existsSync(path.join(home, 'server.json'))).toBe(false);
  }, 60_000);
});
