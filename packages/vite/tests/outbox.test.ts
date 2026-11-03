/**
 * How a test session's events reach the studio from the app's page: however
 * busy the page is, they go out at least once a second; stopping sends all of
 * them; what doesn't arrive is tried again; and a page that can't send for a
 * long time holds a bounded number and says what it dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionBatch, SessionEvent } from '../src/protocol';
import { BATCH, bodies, KEEPALIVE_BYTES, MAX_QUEUE, Outbox, type Delivery } from '../src/bridge/outbox';
import { RequestTally, type NetBody } from '../src/bridge/tally';

/** A studio server: stores each event once (by page and sequence number), like the real one. */
function studio(latency = 15) {
  const stored = new Map<string, SessionEvent & { at: number }>();
  const posts: { at: number; events: number; keepalive: boolean; bytes: number; page: string }[] = [];
  let answer: Delivery = 'stored';
  let failures = 0;
  const post = async (body: string, keepalive: boolean): Promise<Delivery> => {
    await new Promise((r) => setTimeout(r, latency));
    if (answer !== 'stored') {
      if (answer === 'failed') failures++;
      return answer;
    }
    const batch = JSON.parse(body) as SessionBatch;
    posts.push({ at: Date.now(), events: batch.events.length, keepalive, bytes: body.length, page: batch.page });
    for (const e of batch.events) if (!stored.has(`${batch.page}:${e.seq}`)) stored.set(`${batch.page}:${e.seq}`, { ...e, at: Date.now() });
    return 'stored';
  };
  return {
    stored,
    posts,
    post,
    get failures() {
      return failures;
    },
    answer: (a: Delivery) => (answer = a),
  };
}

function outboxFor(server: ReturnType<typeof studio>, page = 'p1') {
  let seq = 0;
  const ended = vi.fn();
  const box = new Outbox(page, { post: server.post, ended, seq: () => ++seq });
  const event = (body: Partial<SessionEvent> = {}): SessionEvent => ({ type: 'console', level: 'error', text: `Error ${seq + 1}`, seq: ++seq, t: Date.now(), ...body }) as SessionEvent;
  return { box, ended, event };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a page that logs errors without a pause', () => {
  it('still sends them as it goes, a few times a second, and every one arrives (120 a second for 10 seconds)', async () => {
    const server = studio();
    const { box } = outboxFor(server);
    const pushed: number[] = [];
    // An error every 8 ms: each one asks to be sent within 50 ms, so a debounced send would never go out.
    for (let i = 0; i < 1250; i++) {
      const e = { type: 'console', level: 'error', text: `Error ${i}`, seq: i + 1, t: Date.now() } as SessionEvent;
      pushed.push(Date.now());
      box.push(e, true);
      await vi.advanceTimersByTimeAsync(8);
    }
    // While the errors were still coming, nearly all of them had arrived.
    expect(server.stored.size).toBeGreaterThan(1200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.stored.size).toBe(1250);
    // Each within a third of a second of being logged.
    const waits = [...server.stored.values()].map((e) => e.at - pushed[e.seq - 1]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(320);
    // A few sends a second, not one per error.
    expect(server.posts.length).toBeLessThanOrEqual(45);
    expect(box.size).toBe(0);
  });

  it('never puts off a send that is due: other events go out within a second of the first one waiting', async () => {
    const server = studio();
    const { box, event } = outboxFor(server);
    const first = Date.now();
    // An ordinary event every 100 ms: a debounced send would wait for a pause that never comes.
    for (let i = 0; i < 30; i++) {
      box.push(event({ type: 'scroll', x: 0, y: i, maxY: 100, el: null }), false);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(server.posts.length).toBeGreaterThanOrEqual(2);
    expect(server.posts[0].at - first).toBeLessThanOrEqual(1000 + 15);
    await vi.advanceTimersByTimeAsync(1100);
    expect(server.stored.size).toBe(30);
  });

  it('sends a backlog batch after batch, each one the server takes in one go', async () => {
    const server = studio();
    const { box, event } = outboxFor(server);
    for (let i = 0; i < 2000; i++) box.push(event(), false);
    await vi.advanceTimersByTimeAsync(400);
    expect(server.stored.size).toBe(2000);
    expect(Math.max(...server.posts.map((p) => p.events))).toBe(BATCH);
  });
});

describe('stopping', () => {
  it('sends everything at once, the first part small enough to outlive the page', async () => {
    const server = studio();
    const { box, event } = outboxFor(server);
    for (let i = 0; i < 2500; i++) box.push(event({ type: 'net', via: 'fetch', method: 'GET', url: `/api/orders/${i}`, status: 500, ok: false, ms: 12, body: 'Internal error' }), true);
    const done = box.retire();
    await vi.advanceTimersByTimeAsync(20);
    await done;
    expect(server.stored.size).toBe(2500);
    expect(server.posts.every((p) => p.events <= BATCH)).toBe(true);
    const kept = server.posts.filter((p) => p.keepalive);
    expect(kept).toHaveLength(1);
    expect(kept[0].bytes).toBeLessThanOrEqual(KEEPALIVE_BYTES);
    expect(box.size).toBe(0);
  });
});

describe('when the studio doesn’t answer', () => {
  it('keeps the events and tries again, less often, until they arrive', async () => {
    const server = studio();
    const { box, event } = outboxFor(server);
    server.answer('failed');
    for (let i = 0; i < 300; i++) {
      box.push(event(), i % 50 === 0);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(server.stored.size).toBe(0);
    expect(box.size).toBe(300);
    // Six seconds down: tried after 1, 2 and 4 seconds, not a few times a second.
    expect(server.failures).toBeLessThanOrEqual(5);
    server.answer('stored');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.stored.size).toBe(300);
    expect(box.size).toBe(0);
  });

  it('holds a bounded number of events, drops sampled signals first, and the session learns how many went', async () => {
    const server = studio();
    const { box, event } = outboxFor(server);
    server.answer('failed');
    let pushed = 0;
    const marks: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const e = i % 4000 === 0 ? event({ type: 'mark', note: `mark ${i}`, via: 'key' }) : i % 2 ? event({ type: 'trail', pts: [0, 1, 2] }) : event();
      if (e.type === 'mark') marks.push(e.seq);
      box.push(e, false);
      pushed++;
      if (i % 100 === 0) await vi.advanceTimersByTimeAsync(10);
    }
    expect(box.size).toBeLessThanOrEqual(MAX_QUEUE);
    server.answer('stored');
    await vi.advanceTimersByTimeAsync(30_000);
    const events = [...server.stored.values()];
    const dropped = events.filter((e): e is Extract<SessionEvent, { type: 'dropped' }> & { at: number } => e.type === 'dropped');
    const lost = dropped.reduce((a, e) => a + e.count, 0);
    // Every event arrived or was counted as dropped; marks always arrive.
    expect(events.length - dropped.length + lost).toBe(pushed);
    for (const seq of marks) expect(server.stored.has(`p1:${seq}`)).toBe(true);
    for (const e of dropped) expect(Object.values(e.kinds).reduce((a, n) => a + n, 0)).toBe(e.count);
    // The pointer's trail went first: what is left of it came after the last time the queue was full; the errors
    // kept are the most recent few thousand.
    const kept = (type: string) => events.filter((e) => e.type === type).length;
    expect(kept('trail')).toBeLessThanOrEqual(MAX_QUEUE / 10);
    expect(kept('console')).toBeGreaterThanOrEqual(MAX_QUEUE * 0.8);
  });
});

describe('a session that ended elsewhere', () => {
  it('stops sending, and says so once', async () => {
    const server = studio();
    const { box, ended, event } = outboxFor(server);
    server.answer('ended');
    box.push(event(), true);
    await vi.advanceTimersByTimeAsync(200);
    box.push(event(), true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(box.size).toBe(0);
  });
});

describe('across a reload', () => {
  it('sends what an earlier load of the page couldn’t, as that page’s', async () => {
    const server = studio();
    const { box, event } = outboxFor(server, 'p2');
    box.carry([{ page: 'p1', events: [{ type: 'vis', hidden: true, seq: 7, t: Date.now() }] }]);
    box.push(event(), false);
    await vi.advanceTimersByTimeAsync(1200);
    expect(server.stored.has('p1:7')).toBe(true);
    expect(server.stored.size).toBe(2);
  });

  it('gives what the server doesn’t have yet, sent or not, in order', async () => {
    const server = studio(500);
    const { box, event } = outboxFor(server);
    for (let i = 0; i < 10; i++) box.push(event(), true);
    await vi.advanceTimersByTimeAsync(100); // a batch is on its way
    for (let i = 0; i < 5; i++) box.push(event(), false);
    const [batch] = box.unsent();
    expect(batch.page).toBe('p1');
    expect(batch.events.map((e) => e.seq)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('cuts a batch into bodies the browser lets a closing page send', () => {
    const events = Array.from({ length: 900 }, (_, i) => ({ type: 'console', level: 'error', text: `Error ${i} ${'x'.repeat(200)}`, seq: i + 1, t: 1 }) as SessionEvent);
    const parts = [...bodies({ page: 'p1', events }, KEEPALIVE_BYTES)];
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(KEEPALIVE_BYTES);
    expect(parts.flatMap((p) => (JSON.parse(p) as SessionBatch).events.map((e) => e.seq))).toEqual(events.map((e) => e.seq));
  });
});

describe('requests the app repeats', () => {
  const ok = (url: string, ms = 20, extra: Partial<NetBody> = {}): NetBody => ({ type: 'net', via: 'fetch', method: 'GET', url, status: 200, ok: true, ms, ...extra });

  it('are counted: the first is recorded as it is, the rest of each second as one event with their count', async () => {
    const recorded: { body: NetBody; t: number }[] = [];
    const tally = new RequestTally((body, t) => recorded.push({ body, t }));
    let counted = 0;
    for (let i = 0; i < 400; i++) {
      const body = ok(`/data.json?i=${i}`, 10 + (i % 3));
      if (tally.count(body, Date.now())) counted++;
      else recorded.push({ body, t: Date.now() });
      await vi.advanceTimersByTimeAsync(5);
    }
    tally.flush();
    expect(counted).toBeGreaterThan(390);
    // A couple of events for two seconds of requests, and every request in them.
    expect(recorded.length).toBeLessThanOrEqual(6);
    expect(recorded.reduce((a, r) => a + 1 + (r.body.repeat ?? 0), 0)).toBe(400);
    const summary = recorded.find((r) => r.body.repeat)!;
    expect(summary.body.ms).toBeGreaterThanOrEqual(10);
    expect(summary.body.ms).toBeLessThanOrEqual(12);
  });

  it('are recorded one by one when they failed, were slow or got a web page back', () => {
    const tally = new RequestTally(() => undefined);
    tally.count(ok('/a'), 0);
    expect(tally.count(ok('/a', 20, { status: 500, ok: false }), 0)).toBe(false);
    expect(tally.count(ok('/a', 1500), 0)).toBe(false);
    expect(tally.count(ok('/a', 20, { ctype: 'text/html', stack: 'at load (src/api.ts:3:9)' }), 0)).toBe(false);
    expect(tally.count(ok('/a', 20, { status: 0, ok: false, error: 'aborted' }), 0)).toBe(false);
    expect(tally.count(ok('/a'), 0)).toBe(true);
  });

  it('are counted apart by address, method and status', () => {
    const tally = new RequestTally(() => undefined);
    for (const body of [ok('/a'), ok('/b'), ok('/a', 20, { method: 'POST' }), ok('/a', 20, { status: 204 })]) expect(tally.count(body, 0)).toBe(false);
    expect(tally.count(ok('/a?x=1'), 0)).toBe(true);
  });
});
