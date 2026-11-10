/**
 * Runs inside the app when it is shown in the studio (Saywright).
 * Answers "what is under this point?", reports element rects, performs clicks
 * and typing on the user's behalf, and records actions for bug reports.
 * Does nothing when the app is opened on its own (not in an iframe).
 */
import {
  NS,
  OLDEST_PROTOCOL,
  PROTOCOL_VERSION,
  SRC_ATTR,
  STUDIO_URL,
  isStudioMessage,
  outdated,
  type BridgeToStudio,
  type Rect,
  type StudioToBridge,
} from '../protocol';
import { clickAt, scrollAt, typeText } from './actions';
import { annotatedAncestor, controlOf, describe, elOf, isVisible, rectOf, stateOf, typesInto } from './dom';
import { snapshot } from './explore';
import { pointIntoComponents, probe, probeSticky, releaseSticky } from './hit';
import { buildLocator } from './locator';
import { find, step } from './nav';
import { act, find as findRecorded, textOf } from './replay';
import { Recorder } from './recorder';
import { own } from './own';
import { installProxyRewrites, proxyConfig } from './proxy';
import { SessionRecorder } from './session';
import { StudioOrigins } from './studios';
import { Widget } from './widget';
import { review, watchVitals } from './experts';

declare global {
  interface Window {
    /** Set by the Vite plugin (or the studio's script): allowed studio origins, the studio's address, whether to show the recorder. */
    __SAYWRIGHT__?: { origins?: string[]; studio?: string; widget?: boolean };
    __saywrightBridge?: boolean;
  }
}

/** Where the studio runs: set by the plugin, learned from the dev server, or the default port. */
async function studioUrl(): Promise<string> {
  const configured = window.__SAYWRIGHT__?.studio;
  if (configured) return configured;
  try {
    const res = await fetch('/__saywright/info', { signal: AbortSignal.timeout(1500) });
    const info = (await res.json()) as { studio?: string | null };
    if (info.studio) return info.studio;
  } catch {
    /* not served by the Vite plugin */
  }
  return STUDIO_URL;
}

/** The app in its own tab: record sessions from a small in-page recorder. */
function standalone(): void {
  const session = new SessionRecorder(() => undefined);
  session.resume();
  if (window.__SAYWRIGHT__?.widget === false) return;
  void studioUrl().then((endpoint) => new Widget(endpoint, session));
}

/** Any bridge message, without the namespace tag `post` adds. */
type Outgoing = BridgeToStudio extends infer M ? (M extends unknown ? Omit<M, 'ns'> : never) : never;

function start(): void {
  let studioOrigin: string | null = null;
  const studios = new StudioOrigins(window.__SAYWRIGHT__);

  const post = (msg: Outgoing) => {
    if (!studioOrigin) return;
    window.parent.postMessage({ ns: NS, ...msg }, studioOrigin);
  };

  const recorder = new Recorder((action) => post({ type: 'recorded', action }));
  const session = new SessionRecorder(
    (stats) => post({ type: 'session', ...stats }),
    (reason) => post({ type: 'moment', reason }),
  );
  // A session started before this page load (a reload or a link) carries on.
  session.resume();

  const reply = (reqId: number, payload: Record<string, unknown>) => post({ type: 'reply', reqId, ok: true, ...payload } as Outgoing);
  const fail = (reqId: number, error: string) => post({ type: 'reply', reqId, ok: false, error });

  const handle = (m: StudioToBridge) => {
    switch (m.type) {
      case 'probe': {
        if (m.x == null || m.y == null || !m.sticky) releaseSticky();
        const hit = m.x == null || m.y == null ? null : m.sticky ? probeSticky(m.x, m.y, m.radius, m.deep) : probe(m.x, m.y, m.radius, m.deep);
        const tracked: Record<string, Rect | null> = {};
        for (const id of m.track) {
          const el = elOf(id);
          tracked[id] = el && isVisible(el) ? rectOf(el) : null;
        }
        post({ type: 'probe', seq: m.seq, hit: hit?.info ?? null, snapped: !!hit?.snapped, tracked });
        return;
      }
      case 'describe': {
        const el = elOf(m.id);
        return el ? reply(m.reqId, { info: describe(el) }) : fail(m.reqId, 'gone');
      }
      case 'reveal': {
        let el = elOf(m.id);
        if (!el && m.src) {
          const all = document.querySelectorAll(`[${SRC_ATTR}="${CSS.escape(m.src)}"]`);
          el = all[Math.min(m.index, all.length - 1)] ?? null;
        }
        if (!el) return fail(m.reqId, 'gone');
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const target = el;
        requestAnimationFrame(() => requestAnimationFrame(() => reply(m.reqId, { info: describe(target) })));
        return;
      }
      case 'explore':
        // Saywright's own work: it stays out of the session's measure of the app.
        return own(() => reply(m.reqId, { snapshot: snapshot() }));
      case 'review': {
        review(m.experts, m.axe, (done) => post({ type: 'progress', reqId: m.reqId, done })).then(
          (r) => reply(m.reqId, { review: r }),
          (err) => fail(m.reqId, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      case 'locator': {
        const el = elOf(m.id);
        if (!el) return fail(m.reqId, 'gone');
        if (!m.check) return reply(m.reqId, { locator: buildLocator(el), info: describe(el) });
        const target = m.check.state ? controlOf(el) : el;
        return reply(m.reqId, { locator: buildLocator(target, m.check.state ? {} : { check: m.check.expected }), info: describe(target), ...(m.check.state ? stateOf(el, target) : {}) });
      }
      case 'step': {
        const el = elOf(m.id);
        if (!el) return fail(m.reqId, 'gone');
        const to = step(el, m.to);
        return reply(m.reqId, { info: to ? describe(to) : null });
      }
      case 'find': {
        const from = m.id ? elOf(m.id) : null;
        if (m.id && !from) return fail(m.reqId, 'gone');
        const to = find(from, m.what, m.where);
        return reply(m.reqId, { info: to ? describe(to) : null });
      }
      case 'replay': {
        const { el, reason } = findRecorded(m.locator, m.like);
        if (!el) return fail(m.reqId, reason ?? 'missing');
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
        if (!m.step) return reply(m.reqId, { info: describe(el), ...(m.read ? { text: textOf(el) } : {}) });
        // The app's response to the step is the app's own work, not Saywright's: it runs in its own task.
        const st = m.step;
        setTimeout(() => {
          try {
            act(el, st);
          } catch (err) {
            return fail(m.reqId, err instanceof Error ? err.message : String(err));
          }
          own(() => reply(m.reqId, { info: el.isConnected ? describe(el) : null }));
        }, 0);
        return;
      }
      case 'goto': {
        // Always a fresh load, even when only the #route differs (a hash change alone keeps the app's state).
        const to = new URL(m.url, location.href);
        if (to.origin !== location.origin) return;
        history.replaceState(history.state, '', to.href);
        location.reload();
        return;
      }
      case 'resolve': {
        const all = document.querySelectorAll(`[${SRC_ATTR}="${CSS.escape(m.src)}"]`);
        const el = all[Math.min(m.index, all.length - 1)] ?? null;
        return reply(m.reqId, { info: el ? describe(el) : null });
      }
      case 'click': {
        const el = clickAt(m.x, m.y);
        return el ? reply(m.reqId, { info: annotatedAncestor(el) ? describe(annotatedAncestor(el)!) : null }) : fail(m.reqId, 'nothing there');
      }
      case 'type': {
        const el = typeText(m.text, m.submit);
        return el ? reply(m.reqId, {}) : fail(m.reqId, 'no field is focused');
      }
      case 'scroll':
        scrollAt(m.x, m.y, m.dx, m.dy);
        return;
      case 'record':
        recorder.setOn(m.on);
        pointIntoComponents(m.on);
        return;
      case 'flush':
        // The steps go out before the reply: the studio places what comes next after them.
        recorder.flushAll();
        return reply(m.reqId, {});
      case 'mouse':
        mouseOn = m.on;
        return;
      case 'keys':
        keysOn = m.on;
        return;
      case 'session':
        if (m.on && m.id && m.endpoint) {
          session.start({ id: m.id, endpoint: m.endpoint, key: m.key });
          // Recording now: the studio waits for this before it shows the session as recording.
          post({ type: 'session', id: m.id, events: 0, issues: 0 });
        } else if (!m.on) session.stop();
        return;
      case 'mark':
        session.mark(m.note, m.via);
        return;
      case 'hello':
        return;
    }
  };

  /** The side to update when this bridge and the studio can't work together (the studio shows it; the app's console says it). */
  let mismatch: 'plugin' | 'studio' | null = null;
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent || !isStudioMessage(e.data)) return;
    const m = e.data as StudioToBridge;
    if (!studios.trusted(e.origin)) {
      // Maybe a studio the bridge hasn't heard of yet: it says hello again in a moment.
      if (m.type === 'hello') void studios.check(e.origin);
      return;
    }
    if (m.type === 'hello') {
      studioOrigin = e.origin;
      const side = outdated({ v: Number(m.v) || 0, oldest: m.oldest }, { v: PROTOCOL_VERSION, oldest: OLDEST_PROTOCOL });
      if (side && side !== mismatch) console.warn(side === 'plugin' ? '[saywright] This app’s Saywright plugin is older than the studio: run npm i -D @saywright/vite@latest and restart the dev server.' : '[saywright] The Saywright studio is older than this app’s plugin: update Saywright (npx @saywright/studio@latest).');
      mismatch = side;
      post({ type: 'ready', v: PROTOCOL_VERSION, oldest: OLDEST_PROTOCOL, url: location.href, title: document.title });
      if (!mismatch) post({ type: 'session', id: session.id, events: 0, issues: 0 });
      return;
    }
    // A studio this bridge can't work with is told so (ready), and nothing else it asks is done.
    if (e.origin !== studioOrigin || mismatch) return;
    try {
      own(() => handle(m));
    } catch (err) {
      if ('reqId' in m) fail(m.reqId, err instanceof Error ? err.message : String(err));
    }
  });

  let mouseOn = false;
  let lastMouse = 0;
  // At most one position a frame, and always the last one: a pointer flicked across the page and stopped is where it
  // stopped, not on what it passed over on the way.
  let pending: { x: number; y: number } | null = null;
  let later: ReturnType<typeof setTimeout> | null = null;
  const sendMouse = () => {
    later = null;
    if (!pending || !mouseOn) return;
    lastMouse = performance.now();
    post({ type: 'mouse', ...pending });
    pending = null;
  };
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!mouseOn) return;
      pending = { x: e.clientX, y: e.clientY };
      const wait = 16 - (performance.now() - lastMouse);
      if (wait <= 0) sendMouse();
      else later ??= setTimeout(sendMouse, wait);
    },
    { passive: true, capture: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    pending = null;
    if (later) clearTimeout(later);
    later = null;
    if (mouseOn) post({ type: 'mouse', x: null, y: null });
  });
  // Into an embedded frame (another page: this one sees no pointer moving in it), the pointer is on the frame itself,
  // a little way in from where it crossed its edge: never left on what it passed over on the way.
  window.addEventListener(
    'pointerover',
    (e) => {
      const frame = e.target;
      if (!mouseOn || !(frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement || frame instanceof HTMLObjectElement || frame instanceof HTMLEmbedElement)) return;
      const r = frame.getBoundingClientRect();
      pending = { x: Math.min(Math.max(e.clientX, r.left + 3), r.right - 3), y: Math.min(Math.max(e.clientY, r.top + 3), r.bottom - 3) };
      sendMouse();
    },
    { passive: true, capture: true },
  );

  let keysOn = false;
  let spaceDown = false;
  window.addEventListener(
    'keydown',
    (e) => {
      if (!keysOn || e.metaKey || e.ctrlKey) return;
      // Alt+Shift+M marks a moment in a test session, even while typing in the app.
      if (e.altKey && e.shiftKey && e.code === 'KeyM' && session.id) {
        e.preventDefault();
        post({ type: 'key', key: 'Mark', down: true });
        return;
      }
      if (e.altKey) return;
      // Typing is decided from where the key really goes: a field inside a web component takes its spaces.
      if (e.code === 'Space' && !typesInto(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat && !spaceDown) {
          spaceDown = true;
          post({ type: 'key', key: 'Space', down: true });
        }
      } else if (e.key === 'Escape') {
        post({ type: 'key', key: 'Escape', down: true });
      }
    },
    true,
  );
  const releaseSpace = () => {
    if (!spaceDown) return;
    spaceDown = false;
    post({ type: 'key', key: 'Space', down: false });
  };
  window.addEventListener(
    'keyup',
    (e) => {
      if (keysOn && e.code === 'Space' && spaceDown) {
        e.preventDefault();
        releaseSpace();
      }
    },
    true,
  );
  window.addEventListener('blur', releaseSpace);

  // A new page says it is here as soon as this script runs: the studio answers at once (the frame's load event can
  // be seconds away, behind a slow image), so a recording carries on before the person does anything on this page.
  // Only to the studios this page already trusts: another page sees nothing.
  for (const origin of studios.announceTo()) {
    try {
      window.parent.postMessage({ ns: NS, type: 'here' }, origin);
    } catch {
      /* not an origin */
    }
  }

  const notify = () => post({ type: 'navigated', url: location.href, title: document.title });
  window.addEventListener('hashchange', notify);
  window.addEventListener('popstate', notify);
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      queueMicrotask(notify);
    };
  }
}

if (!window.__saywrightBridge) {
  window.__saywrightBridge = true;
  // Shown through the studio's proxy: before the site's own scripts run.
  const proxied = proxyConfig();
  if (proxied) installProxyRewrites(proxied);
  // Paint and layout-shift timings from the start, for page reviews.
  watchVitals();
  if (window.parent !== window) start();
  else standalone();
}
