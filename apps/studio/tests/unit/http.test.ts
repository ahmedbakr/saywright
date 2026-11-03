/**
 * The studio's router and event stream: a malformed address is the caller's mistake (400), never a crash, and a
 * client that stops reading the event stream is let go instead of holding every event in memory.
 */
import { EventEmitter } from 'node:events';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventHub, Router } from '../../server/http';

const router = new Router();
router.get('/items/:id', (req) => ({ id: req.params.id }));

let server: http.Server;
let base = '';
beforeAll(async () => {
  const mw = router.middleware('/api');
  server = http.createServer((req, res) => void mw(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));

describe('the router', () => {
  it('decodes parameters', async () => {
    expect(await (await fetch(`${base}/api/items/a%20b`)).json()).toEqual({ id: 'a b' });
  });

  it('answers 400 to a broken %-escape, and keeps serving', async () => {
    const res = await fetch(`${base}/api/items/%E0%A4%A`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'That address has a broken %-escape.' });
    expect((await fetch(`${base}/api/items/1`)).status).toBe(200);
  });
});

describe('the event stream', () => {
  /** A connection whose unsent backlog the test sets. */
  const client = (backlog: number) => {
    const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn(() => true), writableLength: backlog, destroy: vi.fn(() => res.emit('close')) });
    return res;
  };

  it('lets a client go once it stops reading, and keeps sending to the others', () => {
    const events = new EventHub();
    const reading = client(0);
    const stalled = client(2 * 1024 * 1024);
    events.attach(reading as unknown as ServerResponse);
    events.attach(stalled as unknown as ServerResponse);
    events.emit('issue', { text: 'Failed request' });
    events.emit('issue', { text: 'Another' });
    expect(stalled.destroy).toHaveBeenCalledTimes(1);
    expect(stalled.write).toHaveBeenCalledTimes(1); // only ': connected'
    expect(reading.write).toHaveBeenCalledTimes(3);
    expect(reading.write).toHaveBeenLastCalledWith('event: issue\ndata: {"text":"Another"}\n\n');
    reading.emit('close');
  });
});
