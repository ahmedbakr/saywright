/**
 * Where a test session's events wait until the studio has them.
 *
 * - Sending is throttled, never debounced: once a send is due, newer events can
 *   bring it forward but never put it off, so a page that logs or fetches
 *   without a pause still sends, at least once a second.
 * - A send takes everything that was waiting, in batches the server stores in
 *   one go; stopping sends all of it at once.
 * - An event leaves only once the server has it: a batch that didn't arrive goes
 *   back in the queue and is tried again, a little later each time.
 * - The queue is bounded. Past MAX_QUEUE events (the studio not answering for a
 *   while), sampled signals go first, then the oldest events; how many went, of
 *   what kind, reaches the session as an event of its own.
 */
import type { SessionBatch, SessionEvent } from '../protocol';

/** What became of a batch: stored, refused because the session is over (stop sending), or not delivered (try again). */
export type Delivery = 'stored' | 'ended' | 'failed';

interface OutboxDeps {
  /** Post one batch's JSON; `keepalive`: the request may outlive the page. */
  post: (body: string, keepalive: boolean) => Promise<Delivery>;
  /** The server says the session is over. */
  ended: () => void;
  /** The page's next sequence number, for the event saying what was dropped. */
  seq: () => number;
}

/** Events per batch. */
export const BATCH = 400;
/** What a request that may outlive the page can carry: browsers allow 64 KB for all of them together. */
export const KEEPALIVE_BYTES = 60_000;
/** How soon a send follows an event that matters now (an error, a page change), and any other. */
const SOON_MS = 50;
const LATER_MS = 1000;
/** The least time between the starts of two sends: a steady stream goes out a few times a second, not per event. */
const GAP_MS = 250;
export const MAX_QUEUE = 5000;
/** After the session stops here, how long what is left is tried. */
const LAST_TRIES_MS = 30_000;
/** Signals that are sampled anyway: the first to go when the queue is full. */
const THIN = new Set<string>(['trail', 'scroll', 'hover', 'perf', 'dom', 'focus', 'resize', 'vis']);
/** Never dropped: where the session went, what the tester marked, and what was dropped. */
const KEEP = new Set<string>(['page', 'nav', 'mark', 'dropped']);

/** How many events, from `from`, fit in one batch of at most `max` characters (always at least one). */
function fit(events: SessionEvent[], from: number, max: number): number {
  let size = 64; // {"page":"…","events":[…]}
  let i = from;
  for (; i < events.length; i++) {
    size += JSON.stringify(events[i]).length + 1;
    if (size > max && i > from) break;
  }
  return i - from;
}

/** A batch as request bodies of at most `max` characters each (an event is never cut), made as they are asked for. */
export function* bodies(batch: SessionBatch, max: number): Generator<string> {
  for (let i = 0; i < batch.events.length; ) {
    const n = fit(batch.events, i, max);
    yield JSON.stringify({ page: batch.page, events: batch.events.slice(i, i + n) });
    i += n;
  }
}

/** The same batches without the sampled signals. */
export function slim(batches: SessionBatch[]): SessionBatch[] {
  return batches.map((b) => ({ page: b.page, events: b.events.filter((e) => !THIN.has(e.type)) }));
}

export class Outbox {
  private queue: SessionEvent[] = [];
  /** Events from earlier loads of the page (kept across a reload) that the server doesn't have yet. */
  private carried: SessionBatch[] = [];
  private flying = new Set<SessionBatch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  /** When the queue wants to go out (Infinity: nothing is waiting). Only ever brought forward until it has gone. */
  private wanted = Infinity;
  /** Sends wait for this: the gap after the last one, or the wait after a failure. */
  private notBefore = 0;
  private backoff = 0;
  private draining = false;
  private keepaliveBytes = 0;
  private done = false;
  private retiredAt = 0;

  constructor(
    private readonly page: string,
    private readonly deps: OutboxDeps,
  ) {}

  /** Events the server doesn't have yet. */
  get size(): number {
    let n = this.queue.length;
    for (const b of this.carried) n += b.events.length;
    for (const b of this.flying) n += b.events.length;
    return n;
  }

  push(ev: SessionEvent, urgent: boolean): void {
    if (this.done) return;
    this.queue.push(ev);
    if (this.queue.length > MAX_QUEUE) this.trim();
    this.want(urgent || this.queue.length >= BATCH ? SOON_MS : LATER_MS);
  }

  /** Events an earlier load of the page couldn't send: they go with the next send. */
  carry(batches: SessionBatch[]): void {
    for (const b of batches) if (b && typeof b.page === 'string' && Array.isArray(b.events) && b.events.length) this.carried.push(b);
    if (this.carried.length) this.want(SOON_MS);
  }

  /** Send everything now, all batches at once (the session stops, the page may be going); the first may outlive the page. */
  async flush(): Promise<void> {
    if (this.done) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wanted = Infinity;
    const mine = this.queue.splice(0);
    const batches = this.carried.splice(0);
    const cut = mine.length ? fit(mine, 0, KEEPALIVE_BYTES) : 0;
    if (cut) batches.unshift({ page: this.page, events: mine.slice(0, cut) });
    for (let i = cut; i < mine.length; i += BATCH) batches.push({ page: this.page, events: mine.slice(i, i + BATCH) });
    const sent = await Promise.all(batches.map((b) => this.send(b, true)));
    this.settle(sent.every(Boolean), Date.now());
  }

  /** The session stopped here: send what is left now, and keep trying for a while if it doesn't arrive. */
  retire(): Promise<void> {
    this.retiredAt = Date.now();
    return this.flush();
  }

  /** What the server doesn't have yet, by page load, oldest first: kept across a reload. */
  unsent(): SessionBatch[] {
    const out = [...this.carried];
    const mine: SessionEvent[] = [];
    for (const b of this.flying) {
      if (b.page === this.page) mine.push(...b.events);
      else out.push(b);
    }
    mine.push(...this.queue);
    if (mine.length) out.push({ page: this.page, events: mine.sort((a, b) => a.seq - b.seq) });
    return out;
  }

  private want(ms: number): void {
    this.wanted = Math.min(this.wanted, Date.now() + ms);
    this.arm();
  }

  private arm(): void {
    if (this.draining || this.done || this.wanted === Infinity) return;
    const at = Math.max(this.wanted, this.notBefore);
    if (this.timer) {
      if (this.timerAt <= at) return;
      clearTimeout(this.timer);
    }
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.max(0, at - Date.now()));
  }

  /** The regular send: what an earlier page load left, then everything waiting; what arrives meanwhile goes next time. */
  private async drain(): Promise<void> {
    if (this.draining || this.done) return;
    this.draining = true;
    this.wanted = Infinity;
    const started = Date.now();
    let ok = true;
    try {
      while (ok && !this.done && this.carried.length) ok = await this.send(this.carried.shift()!, false);
      let waiting = this.queue.length;
      while (ok && !this.done && this.queue.length && (waiting > 0 || this.queue.length >= BATCH)) {
        const events = this.queue.splice(0, BATCH);
        waiting -= events.length;
        ok = await this.send({ page: this.page, events }, false);
      }
    } finally {
      this.draining = false;
    }
    this.settle(ok, started);
  }

  /** After a send: a short gap (longer after a failure), then on with anything left. */
  private settle(ok: boolean, started: number): void {
    if (this.done) return;
    if (this.retiredAt && Date.now() - this.retiredAt > LAST_TRIES_MS) return this.close();
    if (ok) {
      this.backoff = 0;
      this.notBefore = Math.max(this.notBefore, started + GAP_MS);
    } else {
      this.backoff = Math.min(this.backoff ? this.backoff * 2 : 1000, 10_000);
      this.notBefore = Date.now() + this.backoff;
    }
    if (this.queue.length || this.carried.length) this.want(ok ? LATER_MS : 0);
  }

  /** Post one batch; it goes back if it didn't arrive. */
  private async send(batch: SessionBatch, keepalive: boolean): Promise<boolean> {
    const body = JSON.stringify(batch);
    const ka = keepalive && this.keepaliveBytes + body.length <= KEEPALIVE_BYTES;
    if (ka) this.keepaliveBytes += body.length;
    this.flying.add(batch);
    let result: Delivery;
    try {
      result = await this.deps.post(body, ka);
    } catch {
      result = 'failed';
    } finally {
      this.flying.delete(batch);
      if (ka) this.keepaliveBytes -= body.length;
    }
    if (result === 'ended') {
      if (!this.done) {
        this.close();
        this.deps.ended();
      }
      return true;
    }
    if (result === 'failed' && !this.done) this.restore(batch);
    return result === 'stored';
  }

  private restore(batch: SessionBatch): void {
    if (batch.page !== this.page) {
      this.carried.unshift(batch);
      return;
    }
    this.queue = batch.events.concat(this.queue).sort((a, b) => a.seq - b.seq);
    if (this.queue.length > MAX_QUEUE) this.trim();
  }

  private close(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.carried = [];
  }

  /** Back under the bound, with room to spare: sampled signals first, then the oldest of the rest. */
  private trim(): void {
    let over = this.queue.length - Math.floor(MAX_QUEUE * 0.9);
    const kinds: Record<string, number> = {};
    const drop = (pick: (type: string) => boolean) => {
      if (over <= 0) return;
      this.queue = this.queue.filter((e) => {
        if (over <= 0 || !pick(e.type)) return true;
        over--;
        kinds[e.type] = (kinds[e.type] ?? 0) + 1;
        return false;
      });
    };
    drop((type) => THIN.has(type));
    drop((type) => !KEEP.has(type));
    const count = Object.values(kinds).reduce((a, n) => a + n, 0);
    if (count) this.queue.push({ type: 'dropped', count, kinds, seq: this.deps.seq(), t: Date.now() });
  }
}
