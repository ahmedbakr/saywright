import { afterEach, describe, expect, it, vi } from 'vitest';
import { LET_GO_MS, MAX_WAITING, RequestQueue, type RequestDeps, type RequestJob } from '../../src/core/requests';

/** A request the test finishes when it wants, and what the studio was told about the queue meanwhile. */
function setup() {
  const seen = { started: [] as { text: string; fresh: boolean }[], ended: [] as string[], waiting: [] as string[][], cancelled: [] as string[], failed: [] as unknown[], stopping: [] as string[] };
  const ids = new Map<string, string>();
  const deps: RequestDeps = {
    started: (r, fresh) => (ids.set(r.text, r.id), seen.started.push({ text: r.text, fresh })),
    stopping: (id) => seen.stopping.push(id),
    ended: (id) => seen.ended.push(id),
    waiting: (list) => seen.waiting.push(list.map((w) => w.text)),
    cancel: async (id) => seen.cancelled.push(id),
    fail: (err) => seen.failed.push(err),
  };
  const finish = new Map<string, (fail?: Error) => void>();
  const stoppedAtEnd = new Map<string, boolean>();
  const job = (text: string): RequestJob => ({
    text,
    kind: 'intent',
    step: 'Working',
    run: (_id, stopped) =>
      new Promise<void>((resolve, reject) =>
        finish.set(text, (fail) => {
          stoppedAtEnd.set(text, stopped());
          if (fail) reject(fail);
          else resolve();
        }),
      ),
  });
  return { queue: new RequestQueue(deps), seen, ids, job, finish, stoppedAtEnd };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe('requests, one at a time', () => {
  it('a request asked while another runs waits its turn, in view, then runs', async () => {
    const { queue, seen, job, finish } = setup();
    void queue.ask(job('fix the coupon discount'));
    void queue.ask(job('rename to Use code'));
    expect(seen.started.map((s) => s.text)).toEqual(['fix the coupon discount']);
    expect(seen.waiting.at(-1)).toEqual(['rename to Use code']);
    expect(queue.has('intent')).toBe(true);
    expect(queue.has('test')).toBe(false);
    finish.get('fix the coupon discount')!();
    await tick();
    // Started after a result, it leaves that result on screen (fresh: false).
    expect(seen.started).toEqual([
      { text: 'fix the coupon discount', fresh: true },
      { text: 'rename to Use code', fresh: false },
    ]);
    expect(seen.waiting.at(-1)).toEqual([]);
  });

  it('a stop drops what waits and tells the server; the stopped request still delivers its result', async () => {
    const { queue, seen, ids, job, finish, stoppedAtEnd } = setup();
    const first = queue.ask(job('make it bigger'));
    const second = queue.ask(job('make it red'));
    expect(queue.stop()).toBe(1);
    expect(seen.cancelled).toEqual([ids.get('make it bigger')]);
    expect(seen.stopping).toEqual([ids.get('make it bigger')]);
    expect(seen.waiting.at(-1)).toEqual([]);
    await second; // dropped: it never runs
    // The server had already made the change: its result still arrives, marked as stopped.
    finish.get('make it bigger')!();
    await first;
    expect(stoppedAtEnd.get('make it bigger')).toBe(true);
    expect(seen.started.map((s) => s.text)).toEqual(['make it bigger']);
    expect(queue.busy).toBe(false);
  });

  it(`at most ${MAX_WAITING} wait`, () => {
    const { queue, job } = setup();
    for (let i = 0; i <= MAX_WAITING; i++) expect(queue.ask(job(`request ${i}`))).not.toBeNull();
    expect(queue.ask(job('one too many'))).toBeNull();
  });

  it('a stopped request the server never answers doesn’t hold up the next one', async () => {
    vi.useFakeTimers();
    const { queue, seen, job } = setup();
    void queue.ask(job('a slow one'));
    queue.stop();
    void queue.ask(job('the next one'));
    expect(seen.started.map((s) => s.text)).toEqual(['a slow one']);
    await vi.advanceTimersByTimeAsync(LET_GO_MS);
    expect(seen.started.map((s) => s.text)).toEqual(['a slow one', 'the next one']);
  });

  it('a failure is reported, unless the person had stopped the request', async () => {
    const { queue, seen, job, finish } = setup();
    const a = queue.ask(job('a'));
    finish.get('a')!(new Error('The AI is offline'));
    await a;
    const b = queue.ask(job('b'));
    queue.stop();
    finish.get('b')!(new Error('aborted'));
    await b;
    expect(seen.failed.map((e) => (e as Error).message)).toEqual(['The AI is offline']);
  });
});
