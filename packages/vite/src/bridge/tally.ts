/**
 * Quick, successful requests to the same address within a second: the first is
 * recorded as it is, the others are counted into one event after it (which
 * stands for itself and `repeat` more, with their average time). A page that
 * polls or fetches in a loop then costs a couple of events a second, and the
 * report still counts every request.
 * Requests that went wrong, were slow or got a web page back are never counted:
 * each is recorded on its own.
 */
import type { SessionEventBody } from '../protocol';

export type NetBody = Extract<SessionEventBody, { type: 'net' }>;

const WINDOW_MS = 1000;
/** Slower than this, a request is recorded on its own (the report looks at slow ones). */
const QUICK_MS = 1000;

interface Open {
  since: number;
  count: number;
  ms: number;
  /** When the first counted one was made. */
  t: number;
  last: NetBody | null;
}

export class RequestTally {
  private open = new Map<string, Open>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly record: (body: NetBody, t: number) => void) {}

  /** Whether the request was counted, and so isn't to be recorded on its own. */
  count(body: NetBody, t: number): boolean {
    if (!body.ok || body.stack || body.error || body.ms >= QUICK_MS) return false;
    const key = `${body.method} ${body.url.split(/[?#]/)[0]} ${body.status}`;
    const open = this.open.get(key);
    if (!open) {
      this.open.set(key, { since: Date.now(), count: 0, ms: 0, t: 0, last: null });
      if (!this.timer) this.timer = setTimeout(this.tick, WINDOW_MS);
      return false;
    }
    if (!open.count) open.t = t;
    open.count++;
    open.ms += body.ms;
    open.last = body;
    return true;
  }

  /** Record what has been counted, of every address (the session stops, the page goes). */
  flush(): void {
    this.close(() => true);
  }

  private tick = (): void => {
    this.timer = null;
    const now = Date.now();
    this.close((o) => now - o.since >= WINDOW_MS);
    if (this.open.size) this.timer = setTimeout(this.tick, WINDOW_MS);
  };

  private close(which: (o: Open) => boolean): void {
    for (const [key, o] of this.open) {
      if (!which(o)) continue;
      this.open.delete(key);
      if (o.last) this.record({ ...o.last, ms: Math.round(o.ms / o.count), ...(o.count > 1 ? { repeat: o.count - 1 } : {}) }, o.t);
    }
  }
}
