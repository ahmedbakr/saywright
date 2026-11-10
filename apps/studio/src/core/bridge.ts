/**
 * Studio side of the bridge: talks to the app inside the iframe.
 */
import {
  NS,
  OLDEST_PROTOCOL,
  PROTOCOL_VERSION,
  isStudioMessage,
  outdated,
  type BridgeToStudio,
  type ElementInfo,
  type ExpertId,
  type LocatorInfo,
  type PageReview,
  type PageSnapshot,
  type RecordedAction,
  type Rect,
  type StudioToBridge,
} from '@saywright/vite/protocol';

type Reply = Extract<BridgeToStudio, { type: 'reply' }>;
type ProbeReply = Extract<BridgeToStudio, { type: 'probe' }>;
type Outgoing = StudioToBridge extends infer M ? (M extends unknown ? Omit<M, 'ns'> : never) : never;

export class BridgeClient {
  private frame: HTMLIFrameElement | null = null;
  private origin = '*';
  private nextReq = 1;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout>; wait: () => void; progress?: (done: number) => void }>();
  private oneShot = new Map<number, (m: ProbeReply | null) => void>();
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  ready = false;
  url = '';
  /** The app's bridge and this studio can't work together: the side to update. */
  outdated: 'plugin' | 'studio' | null = null;

  /**
   * The app's page answered. `page` names it (null from a plugin that doesn't say: each answer is then a page), and
   * `loaded` says it has finished loading. A page that announced itself as its script ran answers once before that
   * too, so a recording carries on at once, with `loaded` false: it may have drawn nothing yet.
   */
  onReady: ((info: { url: string; title: string; page: string | null; loaded: boolean }) => void) | null = null;
  onProbe: ((msg: ProbeReply) => void) | null = null;
  onRecorded: ((action: RecordedAction) => void) | null = null;
  onNavigated: ((info: { url: string; title: string }) => void) | null = null;
  onMouse: ((pos: { x: number; y: number } | null) => void) | null = null;
  onKey: ((key: 'Space' | 'Escape' | 'Mark', down: boolean) => void) | null = null;
  /** The app's session recorder: which session it records (it resumes one after a reload). */
  onSession: ((s: { id: string | null; events: number; issues: number }) => void) | null = null;
  /** Something worth a screenshot happened in the app. */
  onMoment: ((reason: string) => void) | null = null;
  /** The app answered, but its bridge and this studio can't work together. */
  onOutdated: ((side: 'plugin' | 'studio') => void) | null = null;

  attach(frame: HTMLIFrameElement, src: string): void {
    this.detach();
    this.frame = frame;
    this.origin = new URL(src).origin;
    window.addEventListener('message', this.onMessage);
    // Cross-origin means the app has loaded; about:blank means wait for the load event.
    let loaded = false;
    try {
      loaded = frame.contentWindow?.location.href !== 'about:blank';
    } catch {
      loaded = true;
    }
    if (loaded) this.sayHello();
  }

  /** Call after the iframe (re)loads: the bridge inside starts fresh. */
  sayHello(): void {
    this.ready = false;
    this.outdated = null;
    if (this.helloTimer) clearInterval(this.helloTimer);
    const hello = () => this.post({ type: 'hello', v: PROTOCOL_VERSION, oldest: OLDEST_PROTOCOL });
    hello();
    this.helloTimer = setInterval(() => {
      if (this.ready || this.outdated) {
        if (this.helloTimer) clearInterval(this.helloTimer);
        return;
      }
      hello();
    }, 400);
  }

  detach(): void {
    window.removeEventListener('message', this.onMessage);
    if (this.helloTimer) clearInterval(this.helloTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.frame = null;
    this.ready = false;
  }

  private post(msg: Outgoing): void {
    const w = this.frame?.contentWindow;
    if (!w) return;
    try {
      w.postMessage({ ns: NS, ...msg }, this.origin);
    } catch {
      /* frame navigating */
    }
  }

  private onMessage = (e: MessageEvent): void => {
    if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== this.origin || !isStudioMessage(e.data)) return;
    const m = e.data as BridgeToStudio;
    switch (m.type) {
      case 'ready': {
        // An app's plugin and the studio are updated separately: one that can't work with the other is named, not used.
        const side = outdated({ v: PROTOCOL_VERSION, oldest: OLDEST_PROTOCOL }, { v: Number(m.v) || 0, oldest: m.oldest });
        if (side) {
          this.outdated = side;
          if (this.helloTimer) clearInterval(this.helloTimer);
          this.onOutdated?.(side);
          break;
        }
        this.ready = true;
        this.url = m.url;
        // A start sent while the app was (re)loading never arrived: say it again (the app ignores a repeat).
        if (this.wanted) this.post({ type: 'session', on: true, ...this.wanted });
        this.onReady?.({ url: m.url, title: m.title, page: typeof m.page === 'string' ? m.page : null, loaded: m.loaded !== false });
        break;
      }
      // A new page announced itself as its script ran, before the frame's load event (which can come before or
      // after this message, and seconds later behind a slow image): it is greeted at once.
      case 'here':
        this.sayHello();
        break;
      case 'probe': {
        const once = this.oneShot.get(m.seq);
        if (once) {
          this.oneShot.delete(m.seq);
          once(m);
        } else if (m.seq === this.seq) this.onProbe?.(m);
        break;
      }
      case 'reply': {
        const p = this.pending.get(m.reqId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.reqId);
          p.resolve(m);
        }
        break;
      }
      case 'recorded':
        this.onRecorded?.(m.action);
        break;
      case 'progress': {
        // Still working: wait for it as long again.
        const p = this.pending.get(m.reqId);
        p?.wait();
        p?.progress?.(m.done);
        break;
      }
      case 'navigated':
        this.url = m.url;
        this.onNavigated?.({ url: m.url, title: m.title });
        break;
      case 'mouse':
        this.onMouse?.(m.x === null || m.y === null ? null : { x: m.x, y: m.y });
        break;
      case 'key':
        this.onKey?.(m.key, m.down);
        break;
      case 'session':
        if (this.starting && m.id === this.starting.id) {
          this.starting.done();
          this.starting = null;
        }
        this.onSession?.({ id: m.id, events: m.events, issues: m.issues });
        break;
      case 'moment':
        this.onMoment?.(m.reason);
        break;
    }
  };

  /** Ask what is under (x, y) in iframe coordinates; null clears hover. Replies arrive via onProbe. */
  /** `sticky`: a hand is pointing, so keep the highlight steady (see probeSticky in the bridge). */
  probe(x: number | null, y: number | null, radius: number, deep: boolean, track: number[], sticky = false): void {
    if (!this.ready) return;
    this.post({ type: 'probe', seq: ++this.seq, x, y, radius, deep, track, sticky });
  }

  /** What is exactly at (x, y) right now: used for clicks, so they never act on a stale hover. */
  probeAt(x: number, y: number, radius: number, deep: boolean): Promise<ElementInfo | null> {
    if (!this.ready) return Promise.resolve(null);
    const seq = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.oneShot.delete(seq);
        resolve(null);
      }, 600);
      this.oneShot.set(seq, (m) => {
        clearTimeout(timer);
        resolve(m?.hit ?? null);
      });
      this.post({ type: 'probe', seq, x, y, radius, deep, track: [] });
    });
  }

  /** `timeout`: how long to wait for the reply, or for the next word of progress. */
  private request(msg: Outgoing & { reqId?: number }, timeout = 2000, progress?: (done: number) => void): Promise<Reply> {
    return new Promise((resolve) => {
      if (!this.ready) return resolve({ ns: NS, type: 'reply', reqId: 0, ok: false, error: 'app not connected' });
      const reqId = this.nextReq++;
      const giveUp = () => {
        this.pending.delete(reqId);
        resolve({ ns: NS, type: 'reply', reqId, ok: false, error: 'timeout' });
      };
      const entry = {
        resolve,
        timer: setTimeout(giveUp, timeout),
        wait: () => {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(giveUp, timeout);
        },
        progress,
      };
      this.pending.set(reqId, entry);
      this.post({ ...msg, reqId } as Outgoing);
    });
  }

  /** Scroll an element into view and describe it where it is now (found again by its source when the page changed). */
  async reveal(id: number, src: string | null, index: number): Promise<ElementInfo | null> {
    const r = await this.request({ type: 'reveal', reqId: 0, id, src, index });
    return r.ok ? (r.info ?? null) : null;
  }

  /** Check the page for the experts asked; a page review can take a few seconds (accessibility), and says how far it has got. */
  async review(experts: ExpertId[], axe: string, progress?: (done: number) => void): Promise<PageReview | null> {
    const r = await this.request({ type: 'review', reqId: 0, experts, axe }, 30_000, progress);
    if (!r.ok) throw new Error(r.error === 'timeout' ? 'The page took too long to check.' : (r.error ?? 'The page couldn’t be checked.'));
    return r.review ?? null;
  }

  async describe(id: number): Promise<ElementInfo | null> {
    const r = await this.request({ type: 'describe', reqId: 0, id });
    return r.ok ? (r.info ?? null) : null;
  }

  /** `check`: for a check that it should show `expected` (or, with `state`, be checked or chosen): see the bridge. */
  async locator(id: number, check?: { expected: string; state?: boolean }): Promise<{ locator: LocatorInfo; info: ElementInfo; checked?: boolean; option?: string; chosen?: string[] } | null> {
    const r = await this.request({ type: 'locator', reqId: 0, id, ...(check ? { check } : {}) });
    return r.ok && r.locator && r.info ? { locator: r.locator, info: r.info, checked: r.checked, option: r.option, chosen: r.chosen } : null;
  }

  /** Out of, into, after or before an element. Null when there is nowhere to go (or the element is gone). */
  async step(id: number, to: 'parent' | 'child' | 'next' | 'prev'): Promise<ElementInfo | null> {
    const r = await this.request({ type: 'step', reqId: 0, id, to });
    return r.ok ? (r.info ?? null) : null;
  }

  /** The nearest element called `what` ("card", "button") around or inside an element, or on screen when `id` is null. */
  async find(id: number | null, what: string, where: 'any' | 'out' | 'in' = 'any'): Promise<ElementInfo | null> {
    const r = await this.request({ type: 'find', reqId: 0, id: id ?? 0, what, where });
    return r.ok ? (r.info ?? null) : null;
  }

  /**
   * Replaying a session: find what a recorded locator points at (brought into view), and do `step` on it, or
   * just read what it shows. Fails with why it couldn't ("missing", "hidden", "unreadable").
   */
  async replay(
    locator: string,
    step?: { kind: 'click' | 'fill' | 'press'; value?: string; key?: string; checked?: boolean; select?: string[]; values?: string[]; byValue?: boolean; guard?: boolean },
    read = false,
    like?: { tag: string; name: string; text: string; shape?: string },
    timeout = 5000,
  ): Promise<{ ok: boolean; info: ElementInfo | null; text?: string; error?: string }> {
    const r = await this.request({ type: 'replay', reqId: 0, locator, step, read, like }, timeout);
    return { ok: r.ok, info: r.info ?? null, text: r.text, error: r.error };
  }

  /** Autopilot: what the page shows and what can be done on it. */
  async explore(): Promise<PageSnapshot | null> {
    const r = await this.request({ type: 'explore', reqId: 0 }, 4000);
    return r.ok ? (r.snapshot ?? null) : null;
  }

  /** Open a page of the app (same origin): the bridge comes back once it has loaded. */
  goto(url: string): void {
    this.post({ type: 'goto', url });
  }

  /** Load the page again where it is (`url`, as it last said), once it has answered (what is being typed sent first); false when it doesn't answer. */
  async reload(url: string): Promise<boolean> {
    const r = await this.request({ type: 'flush', reqId: 0 }, 1500);
    if (!r.ok) return false;
    this.goto(url);
    return true;
  }

  async resolve(src: string, index: number): Promise<ElementInfo | null> {
    const r = await this.request({ type: 'resolve', reqId: 0, src, index });
    return r.ok ? (r.info ?? null) : null;
  }

  async click(x: number, y: number): Promise<{ ok: boolean; info: ElementInfo | null }> {
    const r = await this.request({ type: 'click', reqId: 0, x, y });
    return { ok: r.ok, info: r.info ?? null };
  }

  async type(text: string, submit = false): Promise<{ ok: boolean; error?: string }> {
    const r = await this.request({ type: 'type', reqId: 0, text, submit });
    return { ok: r.ok, error: r.error };
  }

  scroll(x: number, y: number, dx: number, dy: number): void {
    this.post({ type: 'scroll', x, y, dx, dy });
  }

  record(on: boolean): void {
    this.post({ type: 'record', on });
  }

  /**
   * Write test: have the app send the steps still waiting (text being typed) before anything else is placed after
   * them. An app on an older plugin doesn't answer: after a moment, what was recorded so far is all there is.
   */
  async flushRecorder(): Promise<void> {
    await this.request({ type: 'flush', reqId: 0 }, 400);
  }

  trackMouse(on: boolean): void {
    this.post({ type: 'mouse', on });
  }

  forwardKeys(on: boolean): void {
    this.post({ type: 'keys', on });
  }

  /** Start (with the session id and the studio server's address) or stop recording in the app. */
  private starting: { id: string; done: () => void } | null = null;
  /** The session the app should be recording: sent again whenever the app (re)loads. */
  private wanted: { id: string; endpoint: string; key?: string } | null = null;

  /**
   * Start or stop recording in the app. Starting resolves once the app's
   * recorder confirms it is on (a few milliseconds, or once a reloading app is
   * back), so nothing done in the app after the studio shows "recording" is
   * missed; it gives up waiting after three seconds.
   */
  /** Start or stop recording a session in the app. Starting resolves once the app says it is recording (true), or after 3 s (false). */
  session(on: boolean, id?: string, endpoint?: string, key?: string): Promise<boolean> {
    this.wanted = on && id && endpoint ? { id, endpoint, key } : null;
    this.post({ type: 'session', on, id, endpoint, key });
    if (!on || !id) return Promise.resolve(true);
    this.starting?.done();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.starting?.id === id) this.starting = null;
        resolve(false);
      }, 3000);
      this.starting = {
        id,
        done: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
    });
  }

  mark(note: string, via: string): void {
    this.post({ type: 'mark', note, via });
  }
}

export type { ElementInfo, Rect };
