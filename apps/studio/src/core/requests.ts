/**
 * Requests that change code, answer questions or run tests go one at a time, in the order asked. One asked while
 * another runs waits its turn, in view, instead of racing it (two agents editing the same files at once, and the
 * first one's change never shown). Esc stops the running one and drops those waiting. A request's result always
 * reaches its `run`, even after a stop, so a change the server made is never lost from view.
 */
type RequestKind = 'intent' | 'fix' | 'test';

export interface RequestJob {
  /** What the island says is being done. */
  text: string;
  kind: RequestKind;
  /** The first step shown while it works. */
  step: string;
  /** Does the request and shows its result. `stopped()`: whether the person stopped it meanwhile. */
  run: (id: string, stopped: () => boolean) => Promise<void>;
}

interface RunningRequest {
  id: string;
  text: string;
  kind: RequestKind;
  step: string;
  startedAt: number;
}

export interface RequestDeps {
  /** A request starts. `fresh`: none was running, so whatever the island showed is out of date. */
  started: (r: RunningRequest, fresh: boolean) => void;
  /** Stop was asked for; the server is finishing or aborting it. */
  stopping: (id: string) => void;
  /** It is done, or no longer waited for. */
  ended: (id: string) => void;
  /** The requests waiting, in order. */
  waiting: (list: { id: string; text: string }[]) => void;
  /** Ask the server to stop it. */
  cancel: (id: string) => Promise<unknown>;
  fail: (err: unknown) => void;
}

/** How many may wait behind the one running. */
export const MAX_WAITING = 3;
/** How long a stopped request may take to finish before the next one starts anyway. */
export const LET_GO_MS = 4000;

interface Entry {
  id: string;
  job: RequestJob;
  done: () => void;
  stopped: boolean;
}

let seq = 0;

export class RequestQueue {
  private current: Entry | null = null;
  private queue: Entry[] = [];

  constructor(private deps: RequestDeps) {}

  get busy(): boolean {
    return !!this.current;
  }

  /** Whether one of this kind is running or waiting. */
  has(kind: RequestKind): boolean {
    return this.current?.job.kind === kind || this.queue.some((e) => e.job.kind === kind);
  }

  /** Run it now, or after the ones before it. Resolves once it has finished or was dropped; null when too many wait. */
  ask(job: RequestJob): Promise<void> | null {
    if (this.current && this.queue.length >= MAX_WAITING) return null;
    return new Promise((done) => {
      const entry: Entry = { id: `r${++seq}-${Date.now().toString(36)}`, job, done, stopped: false };
      if (!this.current) return void this.begin(entry, true);
      this.queue.push(entry);
      this.publish();
    });
  }

  /** Stop the one running and drop the ones waiting. How many were dropped, or null when nothing was running. */
  stop(): number | null {
    const c = this.current;
    if (!c) return null;
    const dropped = this.queue.splice(0);
    for (const e of dropped) e.done();
    this.publish();
    if (!c.stopped) {
      c.stopped = true;
      this.deps.stopping(c.id);
      void this.deps.cancel(c.id);
      // A server that doesn't answer doesn't hold up what is asked next; what it still returns is shown when it comes.
      setTimeout(() => this.current === c && this.release(c), LET_GO_MS);
    }
    return dropped.length;
  }

  private async begin(e: Entry, fresh: boolean): Promise<void> {
    this.current = e;
    this.deps.started({ id: e.id, text: e.job.text, kind: e.job.kind, step: e.job.step, startedAt: Date.now() }, fresh);
    try {
      await e.job.run(e.id, () => e.stopped);
    } catch (err) {
      if (!e.stopped) this.deps.fail(err);
    } finally {
      e.done();
      if (this.current === e) this.release(e);
    }
  }

  private release(e: Entry): void {
    this.deps.ended(e.id);
    this.current = null;
    const next = this.queue.shift();
    this.publish();
    if (next) void this.begin(next, false);
  }

  private publish(): void {
    this.deps.waiting(this.queue.map((e) => ({ id: e.id, text: e.job.text })));
  }
}
