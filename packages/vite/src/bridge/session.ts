/**
 * Test-session recorder: everything that happens in the app while a session
 * runs, sent in small batches to the studio server.
 *
 * Built to be cheap and lossless:
 * - listeners are passive and do the minimum at event time; the expensive
 *   parts (Playwright locator, React component path) run when the browser is idle;
 * - discrete events (clicks, typing, navigation, errors, requests) are never
 *   sampled; only continuous signals (pointer, scroll) are thinned; the same
 *   error or quick successful request again within a second is counted, not
 *   recorded again;
 * - every event has a sequence number; the outbox sends them at least once a
 *   second however busy the page is, keeps them until the server has them
 *   (across reloads too, in sessionStorage), and the server drops duplicates,
 *   so nothing is lost or doubled.
 */
import { dots, NAME_ATTR, scrubEvent, SRC_ATTR, type SessionBatch, type SessionEvent, type SessionEventBody, type SessionTarget } from '../protocol';
import { annotatedAncestor, collapse, isField, isSecretField, labelText, pageAnnotated, roleOf, screenLines, secretNameOf, sourceHint } from './dom';
import { maskScreen } from './mask';
import { EnterSubmits, formLabel } from './forms';
import { buildLocator, locatorFromInfo } from './locator';
import { bodies, KEEPALIVE_BYTES, Outbox, slim, type Delivery } from './outbox';
import { own, ownTime } from './own';
import { componentPath, fiberOf, hasFiber, reactSource, type Fiber } from './react';
import { RequestTally, type NetBody } from './tally';

const ACTIVE_KEY = 'saywright.session';
const PENDING_KEY = 'saywright.session.pending';
const INTERACTIVE = 'button, a[href], input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
/** Requests that are the dev server or the studio talking, not the app. */
const PLUMBING_URL = /\/@vite\/|\/@fs\/|\/@id\/|\/@react-refresh|\/node_modules\/|__saywright|\.hot-update\.|\/_next\/webpack-hmr|\/__nextjs|sockjs-node|\/api\/sessions\/|\/api\/speech\//;

interface SessionInfo {
  id: string;
  endpoint: string;
  /** What lets this page write to the session (the studio gives it with the session). */
  key?: string;
}

/** Where a session's events go. */
const eventsUrl = (s: SessionInfo): string => `${s.endpoint}/api/sessions/${encodeURIComponent(s.id)}/events${s.key ? `?k=${encodeURIComponent(s.key)}` : ''}`;

interface SessionStats {
  id: string | null;
  events: number;
  issues: number;
}

/** Saywright's own controls on the page (the recorder): what happens there isn't part of the app. */
function ours(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('saywright-recorder');
}

/** How much of the screen's text one look keeps. */
const SCREEN_CHARS = 4000;
/** After an action, the screen counts as settled once nothing changed for SETTLE_MS, or after SETTLED_BY_MS at most. */
const SETTLE_MS = 600;
const SETTLED_BY_MS = 4000;
/** Dialogs and messages: often shown outside the page's main region, in a portal. */
const LAYERS = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]';
const NO_TEXT = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta']);

/** Where the page's words are: its main region and the dialogs and messages outside it, or the whole page without one. */
function screenParts(): HTMLElement[] {
  const main = document.querySelector<HTMLElement>('main, [role="main"]');
  if (!main) return Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !NO_TEXT.has(el.localName) && !ours(el));
  const layers = Array.from(document.querySelectorAll<HTMLElement>(LAYERS)).filter((el) => !main.contains(el) && !ours(el) && !el.parentElement?.closest(LAYERS));
  return [main, ...layers.slice(0, 6)];
}

/** The app's frames of a captured call stack (the recorder's own wrapper frames dropped). */
function callSite(err: Error): string | undefined {
  const lines = (err.stack ?? '').split('\n').slice(1).filter((l) => !/__saywright|(saywright|bridge)\.js/.test(l));
  return lines.length ? lines.slice(0, 8).join('\n') : undefined;
}

function now(): number {
  return performance.timeOrigin + performance.now();
}

function eventTime(e: Event): number {
  return e.timeStamp > 0 ? performance.timeOrigin + e.timeStamp : now();
}

function readJson<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    /* storage full or blocked: events still go out live */
    return false;
  }
}

/** Post a batch of events. The session can't take them when it has ended (404, 409) or isn't this page's to write (403). */
async function deliver(url: string, body: string, keepalive: boolean): Promise<Delivery> {
  try {
    // text/plain keeps the request "simple": no CORS preflight, and it can outlive the page.
    const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive, credentials: 'omit' });
    // Read it to the end: an unread keepalive response holds on to the browser's 64 KB allowance for them.
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 403 || res.status === 404 || res.status === 409) return 'ended';
    return res.ok ? 'stored' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Unsent events kept for the next load of the page, with the session they belong to. */
interface Pending {
  id: string;
  batches: SessionBatch[];
}

/** Safe, short text for anything passed to console.*. */
function format(args: unknown[]): string {
  const seen = new WeakSet<object>();
  const one = (a: unknown): string => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (a instanceof Element) return `<${a.tagName.toLowerCase()}>`;
    try {
      return JSON.stringify(a, (_k, v) => {
        if (typeof v === 'object' && v) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return typeof v === 'function' ? `[fn ${v.name || 'anonymous'}]` : v;
      }) ?? String(a);
    } catch {
      return String(a);
    }
  };
  let s = args.map(one).join(' ');
  // console.error('Warning: %s …', x) style substitutions.
  if (typeof args[0] === 'string' && /%[sdoOif]/.test(args[0])) {
    let i = 1;
    s = (args[0] as string).replace(/%[sdoOif]/g, () => (i < args.length ? one(args[i++]) : '')) + ' ' + args.slice(i).map(one).join(' ');
  }
  return collapse(s, 1200);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin ? u.pathname + u.search : u.href;
  } catch {
    return url;
  }
}

export class SessionRecorder {
  private active: SessionInfo | null = null;
  private readonly page = Math.random().toString(36).slice(2, 10);
  private seq = 0;
  /** The running session's events on their way to the studio. */
  private outbox: Outbox | null = null;
  private tally = new RequestTally((body, t) => this.record(body, t));
  /** Events waiting for their idle-time details; flushed in order. */
  private enriching: { ev: SessionEventBody & { t: number }; targets: [SessionTarget, Element][] }[] = [];
  private idleHandle = 0;
  private stats = { events: 0, issues: 0 };
  private installed = false;
  /** The look at the screen a session starts with, still to take: a moment after it starts, or before the first action. */
  private firstLook: 'start' | 'reload' | null = null;
  /** Requests started, DOM changes seen: lets a click tell whether it did anything. */
  private requests = 0;
  private lastClicks: { t: number; x: number; y: number }[] = [];
  private submits = new EnterSubmits();
  private rageAt = 0;
  private fieldTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  /** When each field being typed in was last typed in: its value is recorded at that moment, not when it is sent. */
  private fieldTimes = new Map<Element, number>();
  private scrollTimers = new Map<EventTarget, ReturnType<typeof setTimeout>>();
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private trail: number[] = [];
  private trailT = 0;
  private lastSample = 0;
  private hoverEl: Element | null = null;
  private hoverSince = 0;
  private cls = 0;
  /** When recording began on this page (performance.now()): the browser also hands over entries from before it, which aren't part of the session. */
  private since = 0;
  /** Recent long tasks on this page's thread, and whether they were the app's: [start, end, app's]. */
  private busy: [number, number, boolean][] = [];

  constructor(
    private onStats: (s: SessionStats) => void,
    /** Something worth a screenshot happened. */
    private onMoment: (reason: string) => void = () => undefined,
  ) {}

  get id(): string | null {
    return this.active?.id ?? null;
  }

  get key(): string | undefined {
    return this.active?.key;
  }

  setMomentHandler(fn: (reason: string) => void): void {
    this.onMoment = fn;
  }

  /** Continue a session after a reload or navigation in the same tab. */
  resume(): void {
    const saved = readJson<SessionInfo>(ACTIVE_KEY);
    if (saved?.id && saved.endpoint) this.begin(saved, true);
  }

  start(info: SessionInfo): void {
    if (this.active?.id === info.id) return;
    if (this.active) this.stop();
    writeJson(ACTIVE_KEY, info);
    this.begin(info, false);
  }

  stop(): void {
    if (!this.active) return;
    this.gather();
    const outbox = this.outbox;
    writeJson(ACTIVE_KEY, null);
    this.active = null;
    this.outbox = null;
    maskScreen(false);
    // Everything left goes now, in as many batches as it takes.
    void outbox?.retire();
    this.report();
  }

  /** The session ended elsewhere (stopped in the studio): stop recording here too. */
  private endedElsewhere(id: string): void {
    if (this.active?.id !== id) return;
    writeJson(ACTIVE_KEY, null);
    this.active = null;
    this.outbox = null;
    maskScreen(false);
    this.report();
  }

  /** Record what is still being put together: a burst's count, a hover, the pointer's trail, typing, counted requests. */
  private gather(): void {
    this.endBurst();
    this.finishHover();
    this.flushTrail();
    this.flushFields();
    this.drainEnrichment();
    this.tally.flush();
    // What the last action led to, as far as it got.
    this.screenSettled();
  }

  mark(note: string, via: string): void {
    if (!this.active) return;
    this.record({ type: 'mark', note: collapse(note, 300), via }, now(), true);
    this.snapshot('mark');
  }

  private begin(info: SessionInfo, resumed: boolean): void {
    this.active = info;
    // The shared screen never shows a secret (its screenshots and video are of the screen).
    maskScreen(true);
    this.outbox = new Outbox(this.page, {
      post: (body, keepalive) => deliver(eventsUrl(info), body, keepalive),
      ended: () => this.endedElsewhere(info.id),
      seq: () => ++this.seq,
    });
    this.lastNavUrl = location.href;
    // After a reload the page's load is part of the session; otherwise only what happens from now on.
    this.since = resumed ? 0 : performance.now();
    this.cls = 0;
    this.install();
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    this.record({
      type: 'page',
      url: location.href,
      title: document.title,
      referrer: document.referrer,
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      ua: navigator.userAgent,
      lang: navigator.language,
      reload: resumed && nav?.type === 'reload',
      timing: nav && nav.loadEventEnd > 0 ? { ttfb: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) } : undefined,
    }, now(), true);
    // Events a previous page load couldn't send before it went away (this session's only).
    const pending = readJson<Pending>(PENDING_KEY);
    writeJson(PENDING_KEY, null);
    if (pending?.id === info.id && Array.isArray(pending.batches)) this.outbox.carry(pending.batches);
    // The first look waits a moment for the page to finish drawing, unless the person acts sooner: then it is taken
    // before that action changes anything (see beforeAction), so it shows the screen as the session found it.
    this.firstLook = resumed ? 'reload' : 'start';
    const later = () => setTimeout(() => this.takeFirstLook(), 300);
    if (document.readyState === 'complete') later();
    else addEventListener('load', later, { once: true });
    this.report();
  }

  // ---- recording -----------------------------------------------------------

  private record(body: SessionEventBody, t: number, urgent = false): void {
    if (!this.active || !this.outbox) return;
    // Secrets never leave the page: addresses, texts and typed values as the protocol's redaction leaves them.
    this.outbox.push(scrubEvent({ ...body, seq: ++this.seq, t: Math.round(t) } as SessionEvent), urgent);
    this.stats.events++;
    if (['error', 'rage', 'dead'].includes(body.type) || (body.type === 'net' && !body.ok && body.error !== 'aborted') || (body.type === 'console' && body.level === 'error')) {
      this.stats.issues++;
      this.onMoment(body.type === 'net' ? 'request-failed' : body.type);
    } else if (body.type === 'nav' || body.type === 'click' || body.type === 'submit' || body.type === 'change') this.onMoment(body.type);
    if ((body.type === 'click' && !body.disabled) || body.type === 'input' || body.type === 'change' || body.type === 'submit' || (body.type === 'key' && (body.key === 'Enter' || body.key === 'Escape'))) this.screenAfter();
    this.report();
  }

  /** A request finished: a quick, successful repeat is counted, anything else recorded (urgently when it failed). */
  private net(body: NetBody, t: number): void {
    if (!this.active || this.tally.count(body, t)) return;
    this.record(body, t, !body.ok && body.error !== 'aborted');
  }

  /** Record once the targets have their idle-time details (locator, component path). */
  private recordLater(body: SessionEventBody, t: number, targets: [SessionTarget, Element][]): void {
    if (!this.active) return;
    this.enriching.push({ ev: { ...body, t }, targets });
    if (!this.idleHandle) {
      const run = () => {
        this.idleHandle = 0;
        this.drainEnrichment();
      };
      this.idleHandle = typeof requestIdleCallback === 'function' ? (requestIdleCallback(run, { timeout: 400 }) as unknown as number) : (setTimeout(run, 50) as unknown as number);
    }
  }

  private drainEnrichment(): void {
    const items = this.enriching;
    this.enriching = [];
    own(() => {
      for (const { ev, targets } of items) {
        for (const [target, el] of targets) this.enrich(target, el);
        const { t, ...body } = ev;
        this.record(body as SessionEventBody, t);
      }
    });
  }

  /** React's record of each target's element, taken when the event happened: by idle time it may be gone (re-rendered, unmounted). */
  private fibers = new WeakMap<SessionTarget, Fiber>();

  private enrich(target: SessionTarget, el: Element): void {
    try {
      const loc = el.isConnected ? buildLocator(el, { cheap: true }) : locatorFromInfo(target.role, target.label, target.text, target.tag);
      target.locator = loc.code;
      target.description = loc.description;
      if (loc.within) target.within = loc.within;
      if (!target.src) target.src = reactSource(this.fibers.get(target) ?? el);
    } catch {
      /* best effort */
    }
  }

  /** What we know about an element right away, without forcing layout beyond its box. */
  private target(el: Element): SessionTarget {
    const anchor = annotatedAncestor(el);
    const tag = el.tagName.toLowerCase();
    const field = isField(el);
    const text = field ? '' : collapse(el.textContent, 80);
    const label =
      el.getAttribute('aria-label') ||
      (field ? labelText(el) || el.getAttribute('placeholder') || el.getAttribute('name') || '' : '') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      text;
    const r = el.getBoundingClientRect();
    const t: SessionTarget = {
      src: anchor?.getAttribute(SRC_ATTR) ?? null,
      name: (anchor === el ? anchor.getAttribute(NAME_ATTR) : null) || tag,
      tag,
      role: roleOf(el),
      label: collapse(label, 60),
      text,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
    const testId = el.getAttribute('data-testid') ?? el.closest('[data-testid]')?.getAttribute('data-testid');
    if (testId) t.testId = testId;
    if (!t.src && !pageAnnotated() && !hasFiber(el)) t.hint = sourceHint(el);
    // Cheap now (a walk up React's tree), and impossible later if this click makes React remove the element.
    const fiber = fiberOf(el);
    if (fiber) {
      t.path = componentPath(fiber);
      this.fibers.set(t, fiber);
    }
    if (tag === 'a' && getComputedStyle(el).display === 'inline') t.inline = true;
    return t;
  }

  private interactive(el: Element): Element {
    return el.closest(INTERACTIVE) ?? el;
  }

  // ---- listeners -----------------------------------------------------------

  private install(): void {
    if (this.installed) return;
    this.installed = true;
    const opts = { capture: true, passive: true } as const;

    // First, before the app's own handlers and the listeners below: the screen as the session found it.
    for (const type of ['pointerdown', 'keydown', 'input', 'change', 'submit', 'click']) addEventListener(type, this.beforeAction, opts);
    addEventListener('click', this.onClick, opts);
    addEventListener('pointerdown', this.onPointerDown, opts);
    addEventListener('input', this.onInput, opts);
    addEventListener('change', this.onChange, opts);
    addEventListener('submit', this.onSubmit, opts);
    addEventListener('keydown', this.onKey, opts);
    addEventListener('focusin', this.onFocus, opts);
    addEventListener('scroll', this.onScroll, opts);
    addEventListener('resize', this.onResize, { passive: true });
    addEventListener('pointermove', this.onPointerMove, opts);
    addEventListener('error', this.onError, true);
    addEventListener('unhandledrejection', this.onRejection);
    // A hash link fires popstate and then hashchange: wait a moment so it is recorded once, as what it was.
    let popTimer: ReturnType<typeof setTimeout> | null = null;
    addEventListener('popstate', () => {
      if (popTimer) clearTimeout(popTimer);
      popTimer = setTimeout(() => ((popTimer = null), this.onNav('pop')), 30);
    });
    addEventListener('hashchange', () => {
      if (popTimer) clearTimeout(popTimer);
      popTimer = null;
      this.onNav('hash');
    });
    document.addEventListener('visibilitychange', () => {
      if (!this.active) return;
      this.record({ type: 'vis', hidden: document.hidden }, now());
      // The tab may be closed from here: send everything now.
      if (document.hidden) {
        this.gather();
        void this.outbox?.flush();
      }
    });
    addEventListener('pagehide', () => this.persist());
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      const self = this;
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const before = location.href;
        const r = original.apply(this, args);
        if (location.href !== before) queueMicrotask(() => self.onNav(method === 'pushState' ? 'push' : 'replace'));
        return r;
      };
    }
    this.patchConsole();
    this.patchFetch();
    this.patchXhr();
    this.observePerformance();
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.active || !(e.target instanceof Element) || ours(e.target)) return;
    // Disabled controls swallow clicks, so record the press instead: a user pressing one is stuck.
    const el = this.interactive(e.target);
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') {
      const target = this.target(el);
      this.recordLater({ type: 'click', x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button, pointer: e.pointerType, el: target, count: 1, disabled: true }, eventTime(e), [[target, el]]);
    }
  };

  private onClick = (e: MouseEvent): void => {
    if (!this.active || !(e.target instanceof Element) || ours(e.target)) return;
    // The browser's own click on the submit button after Enter in a field: the Enter is what the person did.
    if (this.submits.isSubmitClick(e, e.target)) return;
    // What was typed just before goes first (typing, then clicking Save).
    this.flushFields();
    const t = eventTime(e);
    const el = this.interactive(e.target);
    const target = this.target(el);
    const x = Math.round(e.clientX);
    const y = Math.round(e.clientY);
    this.recordLater({ type: 'click', x, y, button: e.button, pointer: (e as PointerEvent).pointerType || 'mouse', el: target, count: e.detail || 1 }, t, [[target, el]]);

    // Rage: three or more clicks within a second on (nearly) the same spot.
    this.lastClicks = this.lastClicks.filter((c) => t - c.t < 1000 && Math.hypot(c.x - x, c.y - y) < 40);
    this.lastClicks.push({ t, x, y });
    if (this.lastClicks.length >= 3 && t - this.rageAt > 1500) {
      this.rageAt = t;
      const rage = this.target(el);
      this.recordLater({ type: 'rage', x, y, clicks: this.lastClicks.length, el: rage }, t, [[rage, el]]);
    }
    this.watchDeadClick(el, x, y, t);
  };

  /** A click on something clickable that changes nothing within a second. */
  private watchDeadClick(el: Element, x: number, y: number, t: number): void {
    if (isField(el) || el instanceof HTMLLabelElement) return;
    // Links that open elsewhere (a new tab, a download, another site, mail) change nothing here by design.
    const link = el.closest('a[href]') as HTMLAnchorElement | null;
    if (link && (link.target === '_blank' || link.hasAttribute('download') || link.origin !== location.origin || /^(mailto|tel|sms):/.test(link.protocol))) return;
    const clickable = el.matches(INTERACTIVE) || getComputedStyle(el).cursor === 'pointer';
    if (!clickable) return;
    const url = location.href;
    const requests = this.requests;
    const focused = document.activeElement;
    const sx = scrollX;
    const sy = scrollY;
    let changed = false;
    const mo = new MutationObserver(() => {
      changed = true;
      mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    setTimeout(() => {
      mo.disconnect();
      if (!this.active || changed || location.href !== url || this.requests !== requests || scrollX !== sx || scrollY !== sy) return;
      if (document.activeElement !== focused && document.activeElement !== el) return;
      const target = this.target(el);
      this.recordLater({ type: 'dead', x, y, el: target }, t, [[target, el]]);
    }, 1000);
  }

  private onInput = (e: Event): void => {
    if (!this.active || !(e.target instanceof Element) || !isField(e.target) || ours(e.target)) return;
    const el = e.target;
    // A choice in a list is a choice (onChange), not typing: Chrome sends `input` before `change` for a <select>.
    if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'range', 'color'].includes(el.type))) return;
    // One event per pause in typing: the value as it stood, when it was typed.
    this.fieldTimes.set(el, eventTime(e));
    const prev = this.fieldTimers.get(el);
    if (prev) clearTimeout(prev);
    this.fieldTimers.set(el, setTimeout(() => this.flushField(el), 700));
  };

  private flushField(el: Element): void {
    const timer = this.fieldTimers.get(el);
    if (timer) clearTimeout(timer);
    const typed = this.fieldTimes.get(el) ?? now();
    this.fieldTimes.delete(el);
    if (!this.fieldTimers.delete(el) || !isField(el)) return;
    const value = 'value' in el ? String(el.value) : '';
    const secret = isSecretField(el);
    const target = this.target(el);
    this.recordLater({ type: 'input', el: target, value: secret ? dots(value) : collapse(value, 500), masked: secret, ...(secret ? { secret: secretNameOf(el) } : {}) }, typed, [[target, el]]);
  }

  private flushFields(): void {
    for (const el of Array.from(this.fieldTimers.keys())) this.flushField(el);
  }

  private onChange = (e: Event): void => {
    if (!this.active || !(e.target instanceof Element) || ours(e.target)) return;
    const el = e.target;
    if (this.fieldTimers.has(el)) return this.flushField(el);
    if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'range', 'color', 'date', 'time'].includes(el.type))) {
      const target = this.target(el);
      // Every option chosen, in a list that takes several; the first is the value, as it always was.
      const options = el instanceof HTMLSelectElement ? Array.from(el.selectedOptions, (o) => collapse(o.label || o.text, 80)) : undefined;
      const value = el instanceof HTMLSelectElement ? (options![0] ?? el.value) : el.type === 'file' ? Array.from(el.files ?? []).map((f) => f.name).join(', ') : el.value;
      this.recordLater(
        { type: 'change', el: target, value: collapse(value, 200), checked: el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : undefined, ...(options && options.length > 1 ? { options } : {}) },
        eventTime(e),
        [[target, el]],
      );
    }
  };

  private onSubmit = (e: Event): void => {
    if (!this.active || !(e.target instanceof Element) || ours(e.target)) return;
    this.flushFields();
    const target = this.target(e.target);
    if (e.target instanceof HTMLFormElement) target.label = formLabel(e.target) || target.label;
    this.recordLater({ type: 'submit', el: target }, eventTime(e), [[target, e.target]]);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (!this.active || e.repeat || ours(e.target)) return;
    this.submits.keydown(e);
    const mods = `${e.ctrlKey ? 'Ctrl+' : ''}${e.metaKey ? 'Meta+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && e.key.length > 1 ? 'Shift+' : ''}`;
    const el = e.target instanceof Element ? e.target : null;
    const typing = !!el && (isField(el) || (el as HTMLElement).isContentEditable);
    // Named keys and shortcuts only: what was typed is captured as the field's value.
    const special = e.key.length > 1 && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Backspace', 'Delete'].includes(e.key);
    const shortcut = (e.ctrlKey || e.metaKey) && e.key.length === 1;
    if (!special && !shortcut) return;
    if (typing && e.key.startsWith('Arrow')) return;
    if (e.key === 'Enter' && el && this.fieldTimers.has(el)) this.flushField(el);
    const target = el && el !== document.body ? this.target(el) : null;
    const body: SessionEventBody = { type: 'key', key: shortcut ? e.key.toUpperCase() : e.key, mods, el: target };
    if (target && el) this.recordLater(body, eventTime(e), [[target, el]]);
    else this.record(body, eventTime(e));
  };

  private onFocus = (e: FocusEvent): void => {
    if (!this.active || !(e.target instanceof Element) || !isField(e.target) || ours(e.target)) return;
    // A password field is remembered as one before anything is typed, should “show password” make it a text field.
    isSecretField(e.target);
    const target = this.target(e.target);
    this.recordLater({ type: 'focus', el: target }, eventTime(e), [[target, e.target]]);
  };

  private onScroll = (e: Event): void => {
    if (!this.active || ours(e.target)) return;
    const key = e.target ?? document;
    if (this.scrollTimers.has(key)) return;
    // Where the scroll settled, at most every 400 ms per scroller.
    this.scrollTimers.set(key, setTimeout(() => {
      this.scrollTimers.delete(key);
      if (!this.active) return;
      const doc = key === document || key === document.documentElement || key === document.body;
      if (doc) {
        this.record({ type: 'scroll', x: Math.round(scrollX), y: Math.round(scrollY), maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight), el: null }, now());
      } else if (key instanceof Element) {
        this.record({ type: 'scroll', x: Math.round(key.scrollLeft), y: Math.round(key.scrollTop), maxY: Math.max(0, key.scrollHeight - key.clientHeight), el: this.target(key) }, now());
      }
    }, 400));
  };

  private onResize = (): void => {
    if (!this.active) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.record({ type: 'resize', w: innerWidth, h: innerHeight }, now()), 500);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.active) return;
    const t = eventTime(e);
    if (t - this.lastSample < 100) return;
    this.lastSample = t;
    if (!this.trail.length) this.trailT = t;
    this.trail.push(Math.round(t - this.trailT), Math.round(e.clientX), Math.round(e.clientY));
    if (t - this.trailT > 2000) this.flushTrail();
    // Resting on something: the browser already hit-tested e.target, so this costs nothing extra.
    const el = e.target instanceof Element && !ours(e.target) ? (annotatedAncestor(e.target) ?? this.interactive(e.target)) : null;
    if (el !== this.hoverEl) {
      this.finishHover(t);
      this.hoverEl = el;
      this.hoverSince = t;
    }
  };

  private flushTrail(): void {
    if (!this.trail.length) return;
    this.record({ type: 'trail', pts: this.trail }, this.trailT);
    this.trail = [];
  }

  private finishHover(t = now()): void {
    const el = this.hoverEl;
    if (!el || !el.isConnected || el === document.body || el === document.documentElement) return;
    const ms = Math.round(t - this.hoverSince);
    if (ms < 600) return;
    const target = this.target(el);
    this.recordLater({ type: 'hover', el: target, ms }, this.hoverSince, [[target, el]]);
    this.hoverEl = null;
  }

  private lastNavUrl = '';

  private onNav(how: 'push' | 'replace' | 'pop' | 'hash'): void {
    if (!this.active || location.href === this.lastNavUrl) return;
    this.lastNavUrl = location.href;
    this.flushFields();
    // The title as the new page sets it: a router's page sets it once it has rendered, after the address changed.
    const at = now();
    const url = location.href;
    setTimeout(() => this.active && this.record({ type: 'nav', url, title: document.title, how }, at, true), 120);
    setTimeout(() => this.snapshot('navigation'), 700);
  }

  private onError = (e: Event): void => {
    if (!this.active) return;
    if (e instanceof ErrorEvent) {
      const err = e.error as Error | undefined;
      const body: SessionEventBody = { type: 'error', kind: 'error', message: collapse(e.message || String(err), 500), stack: err?.stack?.slice(0, 2000), source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined };
      if (this.repeated(`e:${e.message}`, body)) return;
      this.record(body, eventTime(e), true);
      this.snapshotSoon('error');
    } else if (e.target instanceof Element && e.target !== (window as unknown as Element)) {
      // A script, image or stylesheet failed to load.
      const el = e.target as HTMLImageElement & HTMLScriptElement & HTMLLinkElement;
      const url = el.currentSrc || el.src || el.href || '';
      if (PLUMBING_URL.test(url)) return;
      this.record({ type: 'error', kind: 'resource', message: `Couldn’t load ${el.tagName.toLowerCase()} ${shortUrl(url)}` }, eventTime(e), true);
    }
  };

  private onRejection = (e: PromiseRejectionEvent): void => {
    if (!this.active) return;
    const r = e.reason as { message?: string; stack?: string } | undefined;
    const message = collapse(r?.message ?? String(e.reason), 500);
    const body: SessionEventBody = { type: 'error', kind: 'rejection', message, stack: r?.stack?.slice(0, 2000) };
    if (this.repeated(`r:${message}`, body)) return;
    this.record(body, eventTime(e), true);
    this.snapshotSoon('error');
  };

  /**
   * The same error or warning again within a second (a render loop, a polling
   * failure) is counted rather than recorded each time; the count goes out as
   * one follow-up event once the burst ends.
   */
  private repeated(key: string, body: SessionEventBody): boolean {
    const t = now();
    const last = this.burst;
    if (last && last.key === key && t - last.t < 1000) {
      last.count++;
      last.t = t;
      clearTimeout(last.timer);
      last.timer = setTimeout(() => this.endBurst(), 1000);
      return true;
    }
    this.endBurst();
    this.burst = { key, t, count: 0, body, timer: setTimeout(() => this.endBurst(), 1000) };
    return false;
  }

  private burst: { key: string; t: number; count: number; body: SessionEventBody; timer: ReturnType<typeof setTimeout> } | null = null;

  private endBurst(): void {
    const b = this.burst;
    if (!b) return;
    clearTimeout(b.timer);
    this.burst = null;
    // One event for the rest of the burst: itself and `repeat` more.
    if (b.count > 0) this.record({ ...b.body, ...(b.count > 1 ? { repeat: b.count - 1 } : {}) } as SessionEventBody, b.t);
  }

  private patchConsole(): void {
    for (const level of ['error', 'warn'] as const) {
      const original = console[level];
      const self = this;
      console[level] = function (...args: unknown[]) {
        original.apply(console, args);
        if (!self.active) return;
        try {
          const text = format(args);
          if (text.startsWith('[saywright]')) return;
          const err = args.find((a): a is Error => a instanceof Error);
          const stack = (err?.stack ?? new Error().stack?.split('\n').slice(2).join('\n'))?.slice(0, 1500);
          const body: SessionEventBody = { type: 'console', level, text, stack };
          if (self.repeated(`c:${level}:${text}`, body)) return;
          self.record(body, now(), level === 'error');
        } catch {
          /* never break the app's logging */
        }
      };
    }
  }

  private patchFetch(): void {
    const original = window.fetch;
    if (!original) return;
    const self = this;
    window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!self.active || PLUMBING_URL.test(url)) return original.call(this, input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const t = now();
      // Where the app made the request: the browser keeps the frames, and only a request that goes wrong turns them into text.
      const site = new Error();
      self.requests++;
      try {
        const res = await original.call(this, input, init);
        const ms = Math.round(now() - t);
        let body: string | undefined;
        if (!res.ok) {
          try {
            body = collapse(await res.clone().text(), 800);
          } catch {
            /* opaque or streamed */
          }
        }
        const size = Number(res.headers.get('content-length')) || undefined;
        const ctype = res.headers.get('content-type')?.split(';')[0].trim().slice(0, 60) || undefined;
        const suspect = !res.ok || ctype === 'text/html';
        self.net({ type: 'net', via: 'fetch', method, url: shortUrl(url), status: res.status, ok: res.ok, ms, size, body, ctype, stack: suspect ? callSite(site) : undefined }, t);
        return res;
      } catch (err) {
        const aborted = (err as Error)?.name === 'AbortError';
        self.net({ type: 'net', via: 'fetch', method, url: shortUrl(url), status: 0, ok: false, ms: Math.round(now() - t), error: aborted ? 'aborted' : collapse((err as Error)?.message ?? String(err), 200), stack: aborted ? undefined : callSite(site) }, t);
        throw err;
      }
    } as typeof fetch;
  }

  private patchXhr(): void {
    const proto = XMLHttpRequest.prototype;
    const open = proto.open;
    const send = proto.send;
    const self = this;
    const info = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      info.set(this, { method: String(method).toUpperCase(), url: String(url) });
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = info.get(this);
      if (self.active && meta && !PLUMBING_URL.test(meta.url)) {
        const t = now();
        const site = new Error();
        self.requests++;
        this.addEventListener('loadend', () => {
          const ok = this.status >= 200 && this.status < 400;
          let text: string | undefined;
          if (!ok && (this.responseType === '' || this.responseType === 'text')) text = collapse(this.responseText, 800);
          const ctype = this.getResponseHeader('content-type')?.split(';')[0].trim().slice(0, 60) || undefined;
          const stack = !ok || ctype === 'text/html' ? callSite(site) : undefined;
          self.net({ type: 'net', via: 'xhr', method: meta.method, url: shortUrl(meta.url), status: this.status, ok, ms: Math.round(now() - t), body: text, error: this.status === 0 ? 'network error' : undefined, ctype, stack }, t);
        });
      }
      return send.call(this, body);
    };
  }

  private observePerformance(): void {
    const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
      try {
        new PerformanceObserver((list) => {
          if (this.active) cb(list.getEntries());
        }).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      } catch {
        /* not supported in this browser */
      }
    };
    const at = (e: PerformanceEntry) => performance.timeOrigin + e.startTime;
    observe('paint', (es) => {
      for (const e of es) if (e.name === 'first-contentful-paint') this.record({ type: 'perf', metric: 'fcp', value: Math.round(e.startTime) }, at(e));
    });
    observe('largest-contentful-paint', (es) => {
      const e = es[es.length - 1] as PerformanceEntry & { element?: Element | null; renderTime?: number };
      if (e) this.record({ type: 'perf', metric: 'lcp', value: Math.round(e.startTime), el: e.element ? this.target(e.element) : null }, at(e));
    });
    // Only the app's own long tasks. A browser that runs the app in the studio's process (Chromium gives it one of
    // its own) shows the studio's work (speech, drawing) here too, as an ancestor's.
    const alone = window.top === window;
    const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
    observe('longtask', (es) => {
      for (const e of es) {
        const end = e.startTime + e.duration;
        const app = e.name === 'self' || (alone && e.name === 'unknown');
        this.busy.push([e.startTime, end, app]);
        if (!app || e.startTime < this.since) continue;
        const ms = e.duration - ownTime(e.startTime, end);
        if (ms >= 100) this.record({ type: 'perf', metric: 'longtask', value: Math.round(ms) }, at(e));
      }
      const old = performance.now() - 10_000;
      while (this.busy.length && (this.busy[0][1] < old || this.busy.length > 100)) this.busy.shift();
    });
    observe('layout-shift', (es) => {
      for (const e of es as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] })[]) {
        if (e.hadRecentInput || e.startTime < this.since) continue;
        this.cls += e.value;
        if (e.value < 0.02) continue;
        const node = e.sources?.find((s) => s.node instanceof Element)?.node as Element | undefined;
        this.record({ type: 'perf', metric: 'cls', value: +e.value.toFixed(3), el: node ? this.target(node) : null, detail: `total ${this.cls.toFixed(3)}` }, at(e));
      }
    });
    // Slow interactions: how long from input to the next paint (the basis of INP).
    // Once per interaction (a click reports pointerdown, pointerup and click), the slowest part. Input that
    // waited on anything but the app's own long tasks isn't the app being slow: the studio's work on this thread,
    // or, with the app in a process of its own, the browser asking the studio's page where a click landed.
    type EventEntry = PerformanceEntry & { target?: Element | null; interactionId: number; processingStart: number };
    const reported = new Set<number>();
    observe('event', (es) => {
      const worst = new Map<number, EventEntry>();
      for (const e of es as EventEntry[]) {
        if (!e.interactionId || reported.has(e.interactionId)) continue;
        const w = worst.get(e.interactionId);
        if (!w || e.duration > w.duration) worst.set(e.interactionId, e);
      }
      for (const e of worst.values()) {
        if (e.duration < 200 || e.startTime < this.since) continue;
        reported.add(e.interactionId);
        if (reported.size > 200) reported.delete(reported.values().next().value!);
        let mine = 0;
        for (const [a, b, app] of this.busy) if (app) mine += Math.max(0, Math.min(b, e.processingStart) - Math.max(a, e.startTime));
        // Without long tasks to tell (Firefox, Safari), the whole wait counts, as it always did there.
        const others = longTasks ? Math.max(0, e.processingStart - e.startTime - mine) : 0;
        const ms = e.duration - others - ownTime(e.startTime, e.startTime + e.duration);
        if (ms < 200) continue;
        this.record({ type: 'perf', metric: 'inp', value: Math.round(ms), el: e.target ? this.target(e.target) : null, detail: e.name }, at(e));
      }
    }, { durationThreshold: 104 });
  }

  // ---- what the screen says ---------------------------------------------------

  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** The screen as last recorded: a look after an action that finds nothing new records nothing. */
  private lastScreen = '';
  /** How long reading the screen took last time: a page slow to read is read less often. */
  private readMs = 0;
  /** Waiting for the screen to settle after something the person did. */
  private settling: { mo: MutationObserver; quiet: ReturnType<typeof setTimeout>; until: ReturnType<typeof setTimeout> } | null = null;

  /**
   * After something the person did, read the screen once it settles: nothing changed on the page for a moment, or a
   * few seconds at most. What an action led to (a total, a message, a list) is what a report checks it against.
   */
  private screenAfter(): void {
    if (!this.active || !document.body) return;
    // A page slow to read waits longer before each read, so reading stays a small part of its time.
    const quiet = Math.min(10_000, Math.max(SETTLE_MS, this.readMs * 20));
    const wait = () => {
      if (!this.settling) return;
      clearTimeout(this.settling.quiet);
      this.settling.quiet = setTimeout(() => this.screenSettled(), quiet);
    };
    if (this.settling) return wait();
    const mo = new MutationObserver(wait);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.settling = { mo, quiet: setTimeout(() => this.screenSettled(), quiet), until: setTimeout(() => this.screenSettled(), Math.max(SETTLED_BY_MS, quiet * 2)) };
  }

  /** The screen has settled after an action (or the session is ending): read it now. */
  private screenSettled(): void {
    const s = this.settling;
    if (!s) return;
    this.settling = null;
    s.mo.disconnect();
    clearTimeout(s.quiet);
    clearTimeout(s.until);
    this.snapshot('after');
  }

  private snapshotSoon(reason: string): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.snapshot(reason);
    }, 400);
  }

  /** Read the screen now; `at` is the moment the reading stands for (just before an action), else now. */
  private snapshot(reason: string, at?: number): void {
    if (!this.active || !document.body) return;
    own(() => this.readScreen(reason, at));
  }

  /** The look a session starts with, once: when the page has settled, or before the first action if that comes sooner. */
  private takeFirstLook(at?: number): void {
    const reason = this.firstLook;
    if (!reason) return;
    this.firstLook = null;
    this.snapshot(reason, at);
  }

  /** Before the app sees something the person does (the listener runs first): the session's first look, if still to take. */
  private beforeAction = (e: Event): void => {
    if (this.firstLook && this.active && !ours(e.target)) this.takeFirstLook(eventTime(e) - 1);
  };

  private readScreen(reason: string, at?: number): void {
    const started = performance.now();
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .map((h) => collapse(h.textContent, 80))
      .filter(Boolean)
      .slice(0, 12);
    let text = '';
    for (const el of screenParts()) {
      const room = SCREEN_CHARS - text.length - 1;
      if (room < 40) break;
      // A huge page's text is cut before it is split into lines: only the first few thousand characters are kept.
      const part = screenLines(el.innerText.slice(0, room * 4), room);
      if (part) text = text ? `${text}\n${part}` : part;
    }
    this.readMs = performance.now() - started;
    const seen = `${location.href}\n${headings.join('\n')}\n${text}`;
    if (reason === 'after' && seen === this.lastScreen) return;
    this.lastScreen = seen;
    this.record({ type: 'dom', reason, url: location.href, title: document.title, headings, text }, at ?? now());
  }

  // ---- leaving -----------------------------------------------------------------

  /** The page is going away: keep what the server doesn't have yet for the next page load, and send what the browser allows now. */
  private persist(): void {
    if (!this.active || !this.outbox) return;
    this.gather();
    const batches = this.outbox.unsent();
    if (!batches.length) return;
    const id = this.active.id;
    // Too much for the tab's storage: the sampled signals can go.
    if (!writeJson(PENDING_KEY, { id, batches } satisfies Pending)) writeJson(PENDING_KEY, { id, batches: slim(batches) } satisfies Pending);
    try {
      const url = eventsUrl(this.active);
      for (const b of batches) for (const body of bodies(b, KEEPALIVE_BYTES)) if (!navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return;
    } catch {
      /* the next page load sends it */
    }
  }

  private reportTimer = 0;

  private report(): void {
    if (this.reportTimer) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = 0;
      this.onStats({ id: this.active?.id ?? null, events: this.stats.events, issues: this.stats.issues });
    }, 250) as unknown as number;
  }
}
