/**
 * Changes that land at once. The studio writes a change's files one after another, and the dev server would send the
 * page an update for each as it sees them: a page that runs the first file's new code with the second's old code can
 * break ("Cannot read properties of undefined"). While the studio writes several files it asks for the page's updates
 * to be held; once every file it named has been seen (or after a few seconds, if it never finishes), they are sent as
 * one update, which the page applies all together.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Held at most this long: a studio that stopped halfway doesn't leave the page without updates. */
export const HOLD_MS = 4000;
/** Once every file has been seen, how long the dev server must have been quiet before the updates go. */
const SETTLE_MS = 60;

interface Update {
  type: string;
  path: string;
  acceptedPath: string;
  timestamp: number;
  [k: string]: unknown;
}

interface Payload {
  type: string;
  updates?: Update[];
  path?: string;
  [k: string]: unknown;
}

/** What the plugin needs of Vite's dev server: how it talks to pages, and what it hears of files changing. */
interface DevServer {
  ws: { send: (...args: never[]) => void };
  watcher: { on(event: 'add' | 'change' | 'unlink', listener: (file: string) => void): unknown };
}

/** One spelling for a file, however it was named (a link in the path, Windows' separators). */
function same(file: string): string {
  const abs = path.resolve(file);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // Not there (yet, or any more): its folder's real place.
    try {
      return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

export class UpdateHold {
  private held: Payload[] = [];
  private waiting = new Set<string>();
  private holding = false;
  private lastHeld = 0;
  private limit: ReturnType<typeof setTimeout> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private send: (payload: Payload) => void;

  constructor(server: DevServer) {
    // The page's updates go through here (each environment's hot channel is this same object in Vite 6 and later).
    const ws = server.ws as unknown as { send: (...args: unknown[]) => void };
    const original = ws.send;
    this.send = (payload) => original.call(ws, payload);
    ws.send = (...args: unknown[]) => {
      const payload = (typeof args[0] === 'string' ? { type: 'custom', event: args[0], data: args[1] } : args[0]) as Payload;
      if (this.holding && ['update', 'full-reload', 'prune', 'error'].includes(payload?.type)) {
        this.held.push(payload);
        this.lastHeld = Date.now();
        return;
      }
      original.apply(ws, args);
    };
    for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, (file) => this.seen(file));
  }

  /** Hold the page's updates until these files have all changed (or `ms` have passed). */
  hold(files: string[], ms = HOLD_MS): void {
    for (const f of files) this.waiting.add(same(f));
    this.holding = true;
    if (this.limit) clearTimeout(this.limit);
    this.limit = setTimeout(() => this.release(), ms);
    if (!this.waiting.size) this.settled();
  }

  private seen(file: string): void {
    if (!this.holding || !this.waiting.delete(same(file))) return;
    if (!this.waiting.size) this.settled();
  }

  /** Every file has been seen: the dev server works out each one's update in a moment, then they go. */
  private settled(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      if (Date.now() - this.lastHeld < SETTLE_MS) this.settled();
      else this.release();
    }, SETTLE_MS);
  }

  /** Send what was held, as one: a reload if any file needs one, else every update together. */
  release(): void {
    if (this.limit) clearTimeout(this.limit);
    if (this.settle) clearTimeout(this.settle);
    this.limit = this.settle = null;
    this.holding = false;
    this.waiting.clear();
    const held = this.held;
    this.held = [];
    for (const payload of merged(held)) this.send(payload);
  }
}

/** Held updates as the page should get them: at most one reload, or one update with all of them, then the rest in order. */
export function merged(held: Payload[]): Payload[] {
  const reloads = held.filter((p) => p.type === 'full-reload');
  if (reloads.length) return [reloads.length === 1 ? reloads[0] : { type: 'full-reload', path: '*' }];
  const updates = new Map<string, Update>();
  for (const p of held) for (const u of p.updates ?? []) updates.set(`${u.type}\n${u.path}\n${u.acceptedPath}`, u);
  const rest = held.filter((p) => p.type !== 'update');
  return [...(updates.size ? [{ type: 'update', updates: [...updates.values()] }] : []), ...rest];
}
