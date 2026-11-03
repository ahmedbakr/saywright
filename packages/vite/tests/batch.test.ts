/**
 * A change of several files reaches the page as one update: while the studio writes them, what the dev server would
 * send the page is held, and goes once every file it named has changed (or after a few seconds, whatever happens).
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, UpdateHold, merged } from '../src/batch';
import saywright from '../src/index';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-batch-'));
const A = path.join(dir, 'Checkout.tsx');
const B = path.join(dir, 'App.tsx');
const update = (file: string, t = 1) => ({ type: 'update', updates: [{ type: 'js-update', path: `/${path.basename(file)}`, acceptedPath: `/${path.basename(file)}`, timestamp: t }] });

/** Vite's side, as the plugin sees it: what pages are sent, and what the file watcher hears. */
function devServer() {
  const sent: unknown[] = [];
  const watcher = new EventEmitter();
  const ws = { send: (...args: unknown[]) => void sent.push(args.length > 1 ? args : args[0]) };
  return { sent, watcher, ws, server: { ws, watcher } as unknown as ConstructorParameters<typeof UpdateHold>[0] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('holding a page’s updates while a change is written', () => {
  it('sends them as one update once every file has changed', async () => {
    const { sent, watcher, ws, server } = devServer();
    const hold = new UpdateHold(server);
    hold.hold([A, B]);
    // The first file is written; the dev server works out its update.
    watcher.emit('change', A);
    ws.send(update(A));
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([]);
    watcher.emit('change', B);
    ws.send(update(B));
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([{ type: 'update', updates: [...update(A).updates, ...update(B).updates] }]);
    // Afterwards, updates go as they come.
    ws.send(update(A, 2));
    expect(sent).toHaveLength(2);
  });

  it('lets the page’s other messages through meanwhile', () => {
    const { sent, ws, server } = devServer();
    new UpdateHold(server).hold([A, B]);
    ws.send('vite:invoke', { id: 1 });
    ws.send({ type: 'custom', event: 'x' });
    expect(sent).toEqual([['vite:invoke', { id: 1 }], { type: 'custom', event: 'x' }]);
  });

  it('sends what it held after a few seconds when the change is never finished', async () => {
    const { sent, watcher, ws, server } = devServer();
    new UpdateHold(server).hold([A, B]);
    watcher.emit('change', A);
    ws.send(update(A));
    await vi.advanceTimersByTimeAsync(HOLD_MS - 100);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([update(A)]);
  });

  it('reloads the page once when any of the files needs a reload', () => {
    expect(merged([update(A), { type: 'full-reload', path: '*' }, update(B), { type: 'full-reload', path: '/index.html' }])).toEqual([{ type: 'full-reload', path: '*' }]);
    expect(merged([update(A), { type: 'prune', paths: ['/x'] }, update(A, 2)])).toEqual([{ type: 'update', updates: update(A, 2).updates }, { type: 'prune', paths: ['/x'] }]);
  });
});

describe('the route the studio asks it on', () => {
  type Handler = (req: unknown, res: unknown) => void;
  function route(): { fn: Handler; dev: ReturnType<typeof devServer> } {
    const dev = devServer();
    const all: Record<string, Handler> = {};
    const plugin = saywright();
    (plugin.configResolved as (c: unknown) => void)({ root: dir });
    (plugin.configureServer as (s: unknown) => void)({ ...dev.server, middlewares: { use: (r: string, fn: Handler) => (all[r] = fn) } });
    return { fn: all['/__saywright/hold'], dev };
  }
  const call = (fn: Handler, method: string, body: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const req = Object.assign(new EventEmitter(), { method, headers, destroy: () => undefined });
      fn(req, { statusCode: 200, setHeader: () => undefined, end(this: { statusCode: number }, text = '') { resolve({ status: this.statusCode, body: String(text) }); } });
      queueMicrotask(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      });
    });

  it('holds this app’s files for the studio’s server, and nothing for a web page or another app', async () => {
    const { fn, dev } = route();
    expect((await call(fn, 'POST', { files: [A, B] }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(fn, 'GET', {})).status).toBe(405);
    expect((await call(fn, 'POST', { files: ['relative.tsx'] })).status).toBe(400);
    expect(JSON.parse((await call(fn, 'POST', { files: [path.join(os.tmpdir(), 'elsewhere', 'X.tsx')] })).body)).toEqual({ ok: true, held: false });
    dev.ws.send(update(A));
    expect(dev.sent).toHaveLength(1);
    expect(JSON.parse((await call(fn, 'POST', { files: [A, B] })).body)).toEqual({ ok: true, held: true });
    dev.ws.send(update(A));
    expect(dev.sent).toHaveLength(1);
  });
});
