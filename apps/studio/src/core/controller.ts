/**
 * The studio's conductor. Connects the mouse and the microphone → speech →
 * fusion, the app inside the iframe (bridge) and the local API, and turns all
 * of it into a few clear actions: select, ask, keep, undo, test.
 *
 * It runs outside React: per-frame work (probes, the replay's cursor) stays imperative,
 * and React only sees discrete state through the store.
 */
import type { ElementInfo, Rect } from '@saywright/vite/protocol';
import type { UsagePill } from '@shared/ai';
import type { Change, Expectation, IntentResult, NextStep, RecordedStep, RefInfo, StatusResponse, TestRunResult } from '@shared/api';
import type { ReportFinding, ReportSuggestion, SessionAnalysis, SessionDetail, SessionReport, SessionTarget, TimelineItem } from '@shared/session';
import { ApiError, api, subscribe } from '@/lib/api';
import { apps, useApps } from './apps';
import { fileName, plural } from '@/lib/format';
import { CHECK_PHRASES, focusOn, shouldBe, stateWord } from '@shared/text';
import { asShown, showsValue } from '@shared/expected';
import { sanitizeSteps } from '@shared/steps';
import { BridgeClient } from './bridge';
import { looksLikeCheck, parseClientCommand, parseExpectation, type ClientCommand, type Mode, type SpokenExpectation } from './commands';
import { findingBrief } from './evidence';
import { DEFAULT_FUSION, PointerTrack, implicitTargets, resolveDeictics } from './fusion';
import { afterHold, afterTap, picked, replaced, selectedOf, type Picked } from './selection';
import { Autopilot, type AutopilotOptions } from './autopilot';
import { Replayer, findingCheck, namedCheck } from './replay';
import { MAX_WAITING, RequestQueue, type RequestJob } from './requests';
import { modalOpen } from './layers';
import { sessions, useSessions, type SpeechStatus } from './sessions';
import { arabicCommand } from '@shared/arabic-commands';
import { applyTheme, useSettings } from './settings';
import { play, setSoundsEnabled } from './sound';
import { get, initialRecorder, previews, sameEl, set, useStudio, type Binding, type InspectResult, type IslandAction, type MetricsSummary, type RecorderState, type Tone } from './store';
import { alignWords } from './voice/choose';
import { VoiceInput, type VoiceFinal } from './voice/engine';
import type { Word } from './voice/speech';
import { aiName } from '@/lib/ai-name';

const settings = () => useSettings.getState();

const isControl = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('button, select, [role="switch"], [role="tab"], [role="combobox"], [role="option"], [role="slider"], [role="radio"]');

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && !(t as HTMLInputElement).readOnly;

/** A spoken request: its words with timings, and when it was said. */
interface Spoken {
  words: Word[];
  /** Word times are when they were said (not when a recogniser reported them). */
  aligned: boolean;
  span: { start: number; end: number };
}

/** A change or question with what it is about, taken when it was asked (it may wait for its turn). */
interface IntentAsk {
  text: string;
  refs: RefInfo[];
  els: ElementInfo[];
  input: 'voice' | 'typed';
  pointer: 'mouse' | 'none';
  pageUrl: string;
  /** Straight to the AI, past the quick edits (“Ask the AI anyway”). */
  ai?: boolean;
}

/** The ways on from a refusal: `again` asks the AI past the quick edits; `retry` asks the same again (a file changed meanwhile). */
interface Ways {
  again?: () => void;
  retry?: () => void;
}

interface Pointer {
  x: number;
  y: number;
  source: 'mouse';
  radius: number;
  deep: boolean;
  inApp: boolean;
}

/** How often the boxes of what is selected, pinned or changed follow the app (scrolling, layout) with no pointer on it. */
const TRACK_MS = 50;
/** How long the replay's cursor takes to travel to its next target. */
const GUIDE_MS = 380;

/** What the frame loop keeps boxes for, by id. */
const trackedKey = (s: { selection: ElementInfo | null; pins: ElementInfo[]; previewTargets: { el: ElementInfo }[] }) =>
  [s.selection?.id, ...s.pins.map((p) => p.id), ...s.previewTargets.map((p) => p.el.id)].join();

class Controller {
  readonly bridge = new BridgeClient();
  readonly voice = new VoiceInput();
  readonly track = new PointerTrack();
  /** Replay & verify: a session's steps played again in the app, after fixes. */
  readonly replayer = new Replayer({
    bridge: this.bridge,
    connected: () => get().app.connected,
    connections: () => this.appLoads,
    appUrl: () => get().app.url || get().status?.target.url || '',
    enterUse: () => this.useWhilePlaying(),
    show: (view) => set({ replay: view }),
    point: (el, acting) => this.guideTo(el, acting),
    openReport: (id) => sessions.openReport(id),
    notify: (text) => this.notify(text, 'warn'),
  });
  /** Autopilot: the AI uses the app, step by step, recorded as a test session. */
  readonly autopilot = new Autopilot({
    bridge: this.bridge,
    connected: () => get().app.connected,
    connections: () => this.appLoads,
    appUrl: () => get().app.url || get().status?.target.url || '',
    enterUse: () => this.useWhilePlaying(),
    show: (view) => set({ autopilot: view }),
    point: (el, acting) => this.guideTo(el, acting),
    openReport: (id) => sessions.openReport(id),
    notify: (text) => this.notify(text, 'warn'),
  });
  /** The replay's cursor: where it is heading, from where, since when. */
  private guide: { x: number; y: number; fromX: number; fromY: number; at: number } | null = null;

  /** Replay and Autopilot act in Use mode (clicks reach the app); returns how to go back to the mode before. */
  private useWhilePlaying(): () => void {
    const prev = get().mode;
    if (prev !== 'use') this.setMode('use');
    return () => {
      if (get().mode === 'use' && prev !== 'use') this.setMode(prev);
    };
  }

  /** Move the replay's cursor to an element (window coordinates), with a ripple when it acts there. */
  private guideTo(el: ElementInfo | null, acting: boolean): void {
    this.wake();
    const g = this.geom();
    if (!el || !g) {
      this.guide = null;
      return;
    }
    const x = g.left + (el.rect.x + el.rect.w / 2) * g.scale;
    const y = g.top + (el.rect.y + el.rect.h / 2) * g.scale;
    if (acting) this.ripples.push({ x, y, t: performance.now(), kind: 'replay' });
    this.guide = { x, y, fromX: this.guide?.x ?? x - 60, fromY: this.guide?.y ?? y + 80, at: performance.now() };
  }
  /** Times the app's bridge has said it is ready (each page load). */
  private appLoads = 0;
  /** Times the change list was asked for: only the latest answer is shown. */
  private changesAsked = 0;

  readonly ripples: { x: number; y: number; t: number; kind: 'replay' }[] = [];
  /** While set (the setup tour, the voice test in Settings), speech is shown but not acted on. */
  dryRun: ((text: string, heard?: VoiceFinal) => void) | null = null;

  private started = false;
  private frame: HTMLIFrameElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private scale = 1;
  private mouse: { x: number; y: number; alt: boolean } | null = null;
  private appMouse: { x: number; y: number } | null = null;
  private raf = 0;
  /** The frame loop, asleep, comes back for another look at the app then (a resting pointer, boxes to follow). */
  private later: ReturnType<typeof setTimeout> | null = null;
  private frames = 0;
  private clearedProbe = false;
  private lastProbe: { x: number; y: number; t: number; deep: boolean } | null = null;
  /** Whether the open app has shown a page since the studio opened it (the first one is checked against kept steps). */
  private pageSeen = false;
  /** When the boxes of what is selected, pinned or changed were last asked for. */
  private trackedAt = 0;
  /** The cursor canvas has something on it (else it is hidden). */
  private painted = false;
  private spaceDownAt = 0;
  private spaceConsumed = false;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The spoken request waiting in the command bar (review mode). */
  private drafted: Spoken | null = null;
  private lastMouseAt = 0;
  private resolving = new Set<number>();
  private colors: Record<string, string> = {};
  private cleanups: (() => void)[] = [];

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    const s = settings();
    applyTheme(s.theme);
    setSoundsEnabled(s.voice.sounds);
    this.readColors();
    this.applyVoiceSettings();
    // Load the on-device speech model once the studio has settled.
    const warm = setTimeout(() => this.voice.warmUp(), 2500);
    this.cleanups.push(() => clearTimeout(warm));

    this.cleanups.push(
      useSettings.subscribe((now, prev) => {
        if (now.theme !== prev.theme) {
          applyTheme(now.theme);
          requestAnimationFrame(() => this.readColors());
        }
        if (now.voice.sounds !== prev.voice.sounds) setSoundsEnabled(now.voice.sounds);
        if (now.voice !== prev.voice) {
          this.applyVoiceSettings();
          if (now.voice.engine !== prev.voice.engine || now.voice.lang !== prev.voice.lang) this.voice.warmUp();
        }
      }),
    );
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      if (settings().theme === 'system') {
        applyTheme('system');
        requestAnimationFrame(() => this.readColors());
      }
    };
    mq.addEventListener('change', onScheme);
    this.cleanups.push(() => mq.removeEventListener('change', onScheme));

    this.wireVoice();
    this.wireBridge();
    this.cleanups.push(
      subscribe({
        progress: (d) => {
          const p = d as { requestId: string; step: string; detail?: string };
          const r = get().request;
          if (r && r.id === p.requestId && r.step !== 'Stopping') set({ request: { ...r, step: p.step, detail: p.detail } });
        },
        install: (d) => {
          const line = (d as { line: string }).line;
          const r = get().recorder;
          set({ recorder: { ...r, installLog: [...r.installLog, line].slice(-200) } });
        },
        speech: (d) => sessions.serverEvent('speech', d),
        session: (d) => sessions.serverEvent('session', d),
        apps: (d) => apps.serverEvent(d),
        // Today's AI use, after every call: the top bar follows.
        usage: (d) => {
          const st = get().status;
          if (st) set({ status: { ...st, ai: { ...st.ai, usage: d as UsagePill } } });
        },
        // A preview made, kept or undone (in another studio tab, say): this one shows it too, and its boxes go with it.
        changes: () =>
          void this.refreshChanges().then(() => {
            const decided = new Set(get().changes.filter((c) => c.status !== 'preview').map((c) => c.id));
            const targets = get().previewTargets.filter((p) => !decided.has(p.changeId));
            if (targets.length !== get().previewTargets.length) set({ previewTargets: targets });
          }),
        // A change another AI app proposed over MCP: shown like any other, to keep or undo.
        change: (d) => {
          const { change, via } = d as { change: Change; via: string };
          this.upsertChange(change);
          this.refreshAfterEdit();
          play('send');
          this.notify(`${via} proposed a change: ${change.title}. Keep or undo it.`, 'info');
        },
      }, (again) => {
        // Back after a dropped connection: catch up on what was missed meanwhile (a restarted server has the app
        // this page had open opened again).
        if (!again) return;
        void apps.reconnected().then(() => {
          void sessions.resync();
          void this.refreshStatus();
          void this.refreshChanges();
        });
      }),
    );
    // Arabic push-to-talk uses the studio server's model when one is installed.
    const syncServer = (speech: SpeechStatus | null) => {
      const langs = this.voice.server.langs;
      langs.clear();
      if (speech && speech.runtime !== 'missing' && speech.runtime !== 'failed') {
        if (speech.active.ar) langs.add('ar');
        if (speech.active.en) langs.add('en');
      }
    };
    this.cleanups.push(useSessions.subscribe((now, prev) => now.speech !== prev.speech && syncServer(now.speech)));
    sessions.init({
      frame: () => this.frame,
      appConnected: () => get().app.connected,
      appUrl: () => get().app.url || get().status?.target.url || '',
      bridgeSession: (on, id, endpoint, key) => this.bridge.session(on, id, endpoint, key),
      bridgeMark: (note, via) => this.bridge.mark(note, via),
      enterUse: () => {
        const prev = get().mode;
        if (prev !== 'use') this.setMode('use');
        return () => {
          if (get().mode === 'use' && prev !== 'use') this.setMode(prev);
        };
      },
      notify: (text, actions) => this.notify(text, 'ok', actions),
      locate: async (id) => (await this.bridge.locator(id))?.locator ?? null,
    });

    // AI apps connected over MCP see what is selected and pinned.
    this.cleanups.push(useStudio.subscribe((st, prev) => (st.selection !== prev.selection || st.pins !== prev.pins || st.app.url !== prev.app.url ? this.pushContext() : undefined)));

    const down = (e: KeyboardEvent) => this.onKeyDown(e);
    const up = (e: KeyboardEvent) => this.onKeyUp(e);
    const blur = () => this.releaseTalk();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.cleanups.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });

    void apps.init((changed) => this.appSwitched(changed)).then(() => this.restoreRecorder(useApps.getState().active));
    this.cleanups.push(
      useStudio.subscribe((st, prev) => {
        if (st.recorder !== prev.recorder || st.mode !== prev.mode) this.keepRecorder();
      }),
    );
    void this.refreshStatus();
    void this.refreshChanges().then(() => this.announceWaiting());
    // Boxes to keep up with: the frame loop has work again.
    this.cleanups.push(
      useStudio.subscribe((st, prev) => {
        const boxes = (st.selection !== prev.selection || st.pins !== prev.pins || st.previewTargets !== prev.previewTargets) && trackedKey(st) !== trackedKey(prev);
        if (boxes) this.wake();
      }),
    );
    this.wake();
  }

  dispose(): void {
    this.started = false;
    this.rest();
    for (const fn of this.cleanups.splice(0)) fn();
    this.bridge.detach();
  }

  private readColors(): void {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['human', 'ai', 'ok', 'bad', 'fg', 'fg-2', 'inverse', 'glass']) this.colors[k] = cs.getPropertyValue(`--${k}`).trim();
  }

  // ───────────────────────────── stage wiring ─────────────────────────────

  attachFrame(frame: HTMLIFrameElement | null, src?: string): void {
    if (!frame || !src) {
      this.bridge.detach();
      this.frame = null;
      return;
    }
    this.frame = frame;
    this.bridge.attach(frame, src);
  }

  /** The iframe (re)loaded: its bridge starts fresh, so old element ids mean nothing now. */
  frameLoaded(): void {
    // A page that announced itself as its script ran was greeted then, and may already be recording.
    if (this.bridge.takeAnnounced()) return;
    set({ app: { ...get().app, connected: false } });
    this.bridge.sayHello();
  }

  attachCanvas(el: HTMLCanvasElement | null): void {
    this.canvas = el;
    this.painted = false;
    if (el) el.style.visibility = 'hidden';
    this.wake();
  }

  setScale(scale: number): void {
    this.scale = scale || 1;
  }

  private geom(): { left: number; top: number; scale: number; w: number; h: number } | null {
    if (!this.frame) return null;
    const r = this.frame.getBoundingClientRect();
    if (!r.width) return null;
    return { left: r.left, top: r.top, scale: this.scale, w: r.width, h: r.height };
  }

  /** Window coordinates → app (iframe) coordinates. */
  toApp(x: number, y: number): { x: number; y: number } | null {
    const g = this.geom();
    if (!g) return null;
    return { x: (x - g.left) / g.scale, y: (y - g.top) / g.scale };
  }

  private wireBridge(): void {
    const b = this.bridge;
    b.onReady = ({ url, title }) => {
      this.appLoads++;
      set({ app: { ...get().app, connected: true, url, title, outdated: undefined } });
      const mode = get().mode;
      b.trackMouse(mode !== 'edit');
      b.record(mode === 'record');
      b.forwardKeys(true);
      void this.reresolveAll();
      if (this.pageSeen) {
        // A full page load (a link, a form sent, location.href) moved the app: the test waits for the new page too.
        this.recordedPage(url);
      } else {
        // The first page since the studio (or this app) opened: kept steps that end elsewhere don't fit it.
        this.pageSeen = true;
        this.checkKeptSteps(url);
      }
    };
    b.onHere = () => set({ app: { ...get().app, connected: false } });
    b.onOutdated = (outdated) => set({ app: { ...get().app, connected: false, outdated } });
    b.onNavigated = ({ url, title }) => {
      set({ app: { ...get().app, url, title } });
      this.recordedPage(url);
    };
    b.onProbe = (m) => {
      const s = get();
      // Typing a check: what it is about stays outlined while the mouse leaves the app for the keyboard; resting on
      // something else in the app makes that what it is about.
      if (s.typingAbout && s.mode === 'record') {
        if (!m.hit) return;
        set({ typingAbout: m.hit });
      }
      if (!sameEl(s.hover, m.hit) || s.snapped !== m.snapped) set({ hover: m.hit, snapped: m.snapped });
      if (s.hover?.id !== m.hit?.id) sessions.pointed(m.hit, 'mouse');
      // “This” binds to what the mouse was on while it was said.
      this.track.push(performance.now(), m.hit);
      this.applyTracked(m.tracked);
    };
    b.onMouse = (pos) => {
      this.appMouse = pos;
      this.wake();
      if (pos) this.lastMouseAt = performance.now();
    };
    b.onRecorded = (action) => {
      if (get().mode !== 'record') return;
      const r = get().recorder;
      if (action.kind === 'dialog') {
        // A dialog belongs to the step that opened it (recorded just before it): the test answers it before that step.
        const at = r.steps.findLastIndex((s) => s.kind !== 'url' && s.kind !== 'note' && s.kind !== 'goto');
        if (at < 0) return;
        const steps = r.steps.map((s, i) => (i === at ? { ...s, dialogs: [...(s.dialogs ?? []), action.dialog] } : s));
        set({ recorder: { ...r, steps } });
        return;
      }
      const step: RecordedStep = {
        kind: action.kind,
        locator: 'locator' in action ? action.locator : undefined,
        description: action.description,
        value: 'value' in action ? action.value : undefined,
        key: 'key' in action ? action.key : undefined,
        ...(action.kind === 'fill' && action.secret ? { secret: action.secret } : {}),
        ...(action.kind === 'fill' && action.select ? { select: action.select, values: action.values, ...(action.byValue ? { byValue: true } : {}) } : {}),
        ...(action.kind === 'fill' && action.checked !== undefined ? { checked: action.checked } : {}),
        ...(action.kind === 'click' && action.count === 2 ? { count: 2 } : {}),
        ...(action.kind === 'click' && action.button === 'right' ? { button: 'right' as const } : {}),
        ...(action.kind === 'drag' ? { to: action.to } : {}),
        ...(action.kind === 'upload' ? { files: action.files } : {}),
      };
      let before = r.steps;
      if (step.kind === 'click' && step.count === 2) {
        // A double click came as two clicks first: it takes their place (two clicks never make a dblclick).
        let n = 0;
        while (n < 2 && before.length && before.at(-1)!.kind === 'click' && before.at(-1)!.locator === step.locator && !before.at(-1)!.count && !before.at(-1)!.button && !before.at(-1)!.dialogs) {
          before = before.slice(0, -1);
          n++;
        }
      }
      // An older plugin may still send a password in clear: it is a secret by name before it is shown or kept.
      const [clean] = sanitizeSteps([step]);
      set({ recorder: { ...r, steps: [...before, clean] } });
      this.stepAt = performance.now();
    };
    b.onKey = (key, down) => {
      if (key === 'Space') {
        if (down) this.pressTalk();
        else this.releaseTalk();
      } else if (key === 'Escape' && down) this.stop('key');
      else if (key === 'Mark' && down) sessions.mark('', 'shortcut');
    };
    b.onSession = (st) => sessions.bridgeSaid(st.id);
    b.onMoment = (reason) => sessions.moment(reason);
  }

  private trackedIds(): number[] {
    const s = get();
    const ids = new Set<number>();
    if (s.selection) ids.add(s.selection.id);
    for (const p of s.pins) ids.add(p.id);
    for (const p of s.previewTargets) ids.add(p.el.id);
    return [...ids];
  }

  private applyTracked(tracked: Record<string, Rect | null>): void {
    const s = get();
    const upd = (el: ElementInfo): ElementInfo | 'gone' => {
      if (!(String(el.id) in tracked)) return el;
      const r = tracked[el.id];
      if (!r) return 'gone';
      return r.x === el.rect.x && r.y === el.rect.y && r.w === el.rect.w && r.h === el.rect.h ? el : { ...el, rect: r };
    };
    let changed = false;
    const patch: Partial<typeof s> = {};
    if (s.selection) {
      const n = upd(s.selection);
      if (n === 'gone') this.resolveLater(s.selection);
      else if (n !== s.selection) {
        patch.selection = n;
        changed = true;
      }
    }
    const pins = s.pins.map((p) => {
      const n = upd(p);
      if (n === 'gone') {
        this.resolveLater(p);
        return p;
      }
      if (n !== p) changed = true;
      return n;
    });
    if (changed) patch.pins = pins;
    let ptChanged = false;
    const pts = s.previewTargets.map((p) => {
      const n = upd(p.el);
      if (n === 'gone') {
        this.resolveLater(p.el);
        return p;
      }
      if (n !== p.el) ptChanged = true;
      return n === p.el ? p : { ...p, el: n };
    });
    if (ptChanged) patch.previewTargets = pts;
    if (changed || ptChanged) set(patch);
  }

  /** An element left the DOM (hot reload re-rendered it): find it again by its source location. */
  private resolveLater(el: ElementInfo): void {
    if (this.resolving.has(el.id)) return;
    this.resolving.add(el.id);
    setTimeout(async () => {
      const next = el.src ? await this.bridge.resolve(el.src, el.index) : null;
      this.replaceEl(el.id, next);
      setTimeout(() => this.resolving.delete(el.id), 400);
    }, 120);
  }

  private replaceEl(id: number, next: ElementInfo | null): void {
    const s = get();
    set({
      selection: s.selection?.id === id ? next : s.selection,
      pins: s.pins.flatMap((p) => (p.id === id ? (next ? [next] : []) : [p])),
      previewTargets: s.previewTargets.flatMap((p) => (p.el.id === id ? (next ? [{ ...p, el: next }] : []) : [p])),
    });
    if (s.selection?.id === id && next?.src && next.src !== s.selection.src) void this.loadInspect(next);
  }

  private async reresolveAll(): Promise<void> {
    const s = get();
    const find = async (el: ElementInfo) => (el.src ? await this.bridge.resolve(el.src, el.index) : null);
    const selection = s.selection ? await find(s.selection) : null;
    const pins = (await Promise.all(s.pins.map(find))).filter((x): x is ElementInfo => !!x);
    const pts = (await Promise.all(s.previewTargets.map(async (p) => ({ ...p, el: await find(p.el) })))).filter((p): p is { changeId: string; el: ElementInfo } => !!p.el);
    set({ selection, pins, previewTargets: pts, hover: null });
  }

  /** After an edit lands, the app hot-reloads: refresh what we know about targeted elements. A folder of HTML has no hot reload: its page loads again. */
  private refreshAfterEdit(): void {
    const s = get();
    if (s.status?.app?.framework === 'static' && s.app.url) this.bridge.goto(s.app.url);
    for (const delay of [300, 900, 2000]) setTimeout(() => void this.refreshTargets(), delay);
  }

  private async refreshTargets(): Promise<void> {
    const s = get();
    const fresh = async (el: ElementInfo) => (await this.bridge.describe(el.id)) ?? (el.src ? await this.bridge.resolve(el.src, el.index) : null);
    const selection = s.selection ? await fresh(s.selection) : null;
    const pins = (await Promise.all(s.pins.map(fresh))).filter((x): x is ElementInfo => !!x);
    const pts = (await Promise.all(s.previewTargets.map(async (p) => ({ ...p, el: await fresh(p.el) })))).filter((p): p is { changeId: string; el: ElementInfo } => !!p.el);
    const now = get();
    set({
      selection: now.selection?.id === s.selection?.id ? selection : now.selection,
      pins: now.pins === s.pins ? pins : now.pins,
      previewTargets: now.previewTargets === s.previewTargets ? pts : now.previewTargets,
    });
    const sel = get().selection;
    if (sel) void this.loadInspect(sel, true);
  }

  // ───────────────────────────── frame loop ─────────────────────────────
  //
  // What the pointer is on in the app, the boxes that follow what is selected, and the canvas the replay's cursor
  // is drawn on. The loop runs while something moves or needs following and sleeps otherwise, so an idle studio costs
  // nothing; whatever gives it work again wakes it.

  private wake = (): void => {
    if (this.raf || !this.started) return;
    if (this.later) clearTimeout(this.later);
    this.later = null;
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Stop the frame loop until something wakes it. */
  private rest(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.later) clearTimeout(this.later);
    this.later = null;
  }

  private loop = (now: number): void => {
    this.raf = 0;
    this.frames++;

    const p = this.pointer();
    const pointerKind = p ? p.source : null;
    if (get().pointer !== pointerKind) set({ pointer: pointerKind });

    // Ask the app what is under the pointer; refresh tracked boxes otherwise. A pointer resting still, with
    // no boxes to keep up with, is asked about a few times a second rather than every frame.
    const ids = this.trackedIds();
    const g = this.geom();
    let resting = false;
    if (p && p.inApp && g) {
      const ax = (p.x - g.left) / g.scale;
      const ay = (p.y - g.top) / g.scale;
      const last = this.lastProbe;
      resting = !!last && !ids.length && Math.abs(ax - last.x) < 0.75 && Math.abs(ay - last.y) < 0.75 && now - last.t < 200 && last.deep === p.deep;
      if (!resting) {
        this.bridge.probe(ax, ay, p.radius / g.scale, p.deep, ids);
        this.lastProbe = { x: ax, y: ay, t: now, deep: p.deep };
      }
      this.clearedProbe = false;
    } else if (!this.clearedProbe || (ids.length && now - this.trackedAt >= TRACK_MS)) {
      this.lastProbe = null;
      this.bridge.probe(null, null, 0, false, ids);
      this.clearedProbe = true;
      this.trackedAt = now;
    }

    this.draw(now);

    // Every frame while something moves; a little later while a resting pointer or boxes only need watching.
    const moving = this.ripples.length > 0 || (!!this.guide && now - this.guide.at < GUIDE_MS) || (!!p?.inApp && !resting);
    if (moving) this.raf = requestAnimationFrame(this.loop);
    else if (p?.inApp || ids.length) this.later = setTimeout(this.wake, p?.inApp ? 200 : TRACK_MS);
  };

  private pointer(): Pointer | null {
    const mode = get().mode;
    if (mode === 'edit' && this.mouse) return { ...this.mouse, source: 'mouse', radius: 0, deep: this.mouse.alt, inApp: true };
    if (mode !== 'edit' && this.appMouse) {
      const g = this.geom();
      if (!g) return null;
      return { x: g.left + this.appMouse.x * g.scale, y: g.top + this.appMouse.y * g.scale, source: 'mouse', radius: 0, deep: false, inApp: true };
    }
    return null;
  }

  // ───────────────────────────── drawing ─────────────────────────────

  private draw(now: number): void {
    const c = this.canvas;
    if (!c) return;
    // Nothing to show: cleared once, and hidden. A canvas drawn on over the app makes the browser ask the studio's
    // page where each click in the app lands, and that waits whenever the studio is busy.
    if (!this.ripples.length && !this.guide) {
      if (this.painted) {
        c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
        c.style.visibility = 'hidden';
        this.painted = false;
      }
      return;
    }
    if (!this.painted) c.style.visibility = 'visible';
    this.painted = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      const age = (now - r.t) / 450;
      if (age >= 1) {
        this.ripples.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = (1 - age) * 0.9;
      ctx.strokeStyle = this.colors.ai || '#3dd6f5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 10 + age * 24, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Replaying a session: a pointer that travels to each step's target (in the AI's colour: it isn't you).
    const gd = this.guide;
    if (gd) {
      const k = Math.min(1, (now - gd.at) / GUIDE_MS);
      const e = 1 - Math.pow(1 - k, 3);
      const gx = gd.fromX + (gd.x - gd.fromX) * e;
      const gy = gd.fromY + (gd.y - gd.fromY) * e;
      const ai = this.colors.ai || '#3dd6f5';
      ctx.globalAlpha = 1;
      ctx.fillStyle = ai;
      ctx.strokeStyle = this.colors.inverse || '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + 3.5, gy + 17);
      ctx.lineTo(gx + 7.5, gy + 12.5);
      ctx.lineTo(gx + 14, gy + 13);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  // ───────────────────────────── mouse on the stage (Edit mode) ─────────────────────────────

  mouseMove(x: number, y: number, alt: boolean): void {
    this.mouse = { x, y, alt };
    this.lastMouseAt = performance.now();
    this.wake();
  }

  mouseLeave(): void {
    this.mouse = null;
    this.wake();
  }

  /** A click selects, deselects what is the only thing selected, or clears; ⇧ click adds or takes out. */
  async mouseClick(x: number, y: number, shift: boolean, alt: boolean, count = 1): Promise<void> {
    // A double click selects, like a single one (its second click would deselect again).
    if (count > 1) return;
    const a = this.toApp(x, y);
    const run = (async () => {
      const hit = (a ? await this.bridge.probeAt(a.x, a.y, 0, alt) : null) ?? get().hover;
      const now: Picked = { selection: get().selection, pins: get().pins };
      this.setPicked(shift ? afterHold(now, hit) : afterTap(now, hit));
    })();
    this.picking = run;
    try {
      await run;
    } finally {
      if (this.picking === run) this.picking = null;
    }
  }

  /** A click's selection, still on its way back from the app: a request sent right after it waits for it. */
  private picking: Promise<void> | null = null;

  wheel(dx: number, dy: number): void {
    const m = this.mouse;
    if (!m) return;
    const a = this.toApp(m.x, m.y);
    if (a) this.bridge.scroll(a.x, a.y, dx / this.scale, dy / this.scale);
  }

  // ───────────────────────────── selection ─────────────────────────────

  /** Select just this one (or nothing). */
  select(el: ElementInfo | null): void {
    this.setPicked(picked(el ? [el] : []));
  }

  private setPicked(p: Picked): void {
    const s = get();
    const el = p.selection;
    const same = el?.id === s.selection?.id;
    const inspect = same || (el?.src && s.inspect?.file && el.src.startsWith(s.inspect.file + ':')) ? s.inspect : null;
    set({ selection: el, pins: p.pins, inspect: el ? inspect : null });
    if (el && (!same || !s.inspect)) void this.loadInspect(el);
  }

  /** Add to the selection, or take out of it: ⇧ click, “add this”. */
  toggleSelected(el: ElementInfo): void {
    this.setPicked(afterHold({ selection: get().selection, pins: get().pins }, el));
  }

  /** Take one element out of the selection. */
  deselect(id: number): void {
    const s = get();
    this.setPicked(picked(selectedOf(s).filter((e) => e.id !== id), s.selection));
  }

  clearTargets(): void {
    set({ selection: null, pins: [], inspect: null });
  }

  /** Move the selection out, in, to the next or the previous one. With several selected, the one shown moves. */
  async step(to: 'parent' | 'child' | 'next' | 'prev'): Promise<void> {
    const sel = get().selection;
    if (!sel) return this.notify(to === 'parent' ? 'Select something first, then go up to what contains it.' : 'Select something first.', 'info');
    const next = await this.bridge.step(sel.id, to);
    if (!next) {
      const why = { parent: 'That’s already the outermost element.', child: 'There’s nothing inside it to select.', next: 'That’s the last one.', prev: 'That’s the first one.' };
      return this.notify(why[to], 'info');
    }
    const s = get();
    if (s.selection?.id === sel.id) this.setPicked(replaced(s, sel, next));
  }

  selectParent(): Promise<void> {
    return this.step('parent');
  }

  /** “The card”, “the button inside”: the nearest one around or inside the selection (or what you point at). */
  async selectCalled(what: string, where: 'any' | 'out' | 'in', from: ElementInfo | null): Promise<void> {
    const el = await this.bridge.find(from?.id ?? null, what, where);
    if (!el) {
      const place = !from ? 'on the page' : where === 'in' ? 'inside it' : where === 'out' ? 'around it' : 'around or inside it';
      return this.notify(`Couldn’t find a “${what}” ${place}.`, 'info');
    }
    const s = get();
    if (s.selection && from?.id === s.selection.id) this.setPicked(replaced(s, s.selection, el));
    else this.select(el);
  }

  /** Where the element is written, as the server traces it (`guessed` when it was found by searching the code). */
  private traceEl(el: ElementInfo): Promise<{ result: InspectResult | null }> {
    return api.post<{ result: InspectResult | null }>('/inspect', { ref: { src: el.src, frames: el.frames, hint: el.hint, tag: el.tag, text: el.text }, pageUrl: get().app.url });
  }

  async loadInspect(el: ElementInfo, quiet = false): Promise<void> {
    if (!quiet) set({ inspectLoading: true });
    try {
      const { result } = await this.traceEl(el);
      if (get().selection?.id === el.id) set({ inspect: result });
    } catch {
      /* the inspector just stays empty */
    } finally {
      if (!quiet) set({ inspectLoading: false });
    }
  }

  async setProp(prop: string, value: string): Promise<void> {
    const sel = get().selection;
    if (!sel?.src) return;
    try {
      const res = await api.post<IntentResult>('/props', { src: sel.src, prop, value });
      this.applyResult(res, `${prop}: ${value}`, [sel], { retry: () => void this.setProp(prop, value) });
    } catch (err) {
      this.fail(err);
    }
  }

  async openInEditor(el?: ElementInfo | null): Promise<void> {
    const target = el ?? get().selection ?? get().hover;
    if (!target) return this.notify('Point at or select something from your app first.', 'info');
    const insp = get().inspect;
    let info = insp && target.id === get().selection?.id ? insp : null;
    if (!info) {
      try {
        info = (await this.traceEl(target)).result;
      } catch {
        info = null;
      }
    }
    if (!info) return this.notify('Couldn’t find that element’s source file.', 'warn');
    await this.openFile(info.absPath, info.line, info.col);
  }

  async openFile(absPath: string, line = 1, col = 1): Promise<void> {
    const where = `${absPath.split('/').slice(-2).join('/')}:${line}`;
    const res = await fetch(`/__open-in-editor?file=${encodeURIComponent(`${absPath}:${line}:${col}`)}`, { method: 'POST' }).catch(() => null);
    if (res?.ok) return this.notify(`Opening ${where} in your editor…`, 'info');
    const why = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error;
    this.notify(why ?? `Couldn’t open ${where} in your editor.`, 'warn');
  }

  /** Paths in answers are relative to the app's folder. */
  openRelative(rel: string, line = 1): void {
    const root = get().status?.target.root;
    if (!root) return;
    void this.openFile(`${root.replace(/\/$/, '')}/${rel}`, line, 1);
  }

  async copyLocator(el: ElementInfo): Promise<void> {
    const loc = await this.bridge.locator(el.id);
    if (!loc) return this.notify('Couldn’t build a locator for that element.', 'warn');
    await navigator.clipboard?.writeText(loc.locator.code).catch(() => undefined);
    this.notify(`Copied ${loc.locator.code}`, 'ok');
  }

  // ───────────────────────────── modes ─────────────────────────────

  setMode(mode: Mode): void {
    const prev = get().mode;
    if (prev === mode) return;
    this.mouse = null;
    if (mode === 'record') this.stepAt = performance.now();
    this.appMouse = null;
    this.wake();
    set({ mode, hover: null });
    this.bridge.trackMouse(mode !== 'edit');
    this.bridge.record(mode === 'record');
    if (mode === 'record') {
      const r = get().recorder;
      if (!r.steps.length && !r.expectations.length) set({ recorder: { ...initialRecorder, startUrl: get().app.url || get().status?.target.url || null } });
      settings().setUi({ panelOpen: true, panelTab: 'test' });
    }
  }

  /**
   * A new test: from the page the app is on, or (`fromStart`) from the app's start page, which the app goes back to. A
   * test opens the app in a fresh browser, signed out: from a page that needs signing in, it starts from the start page.
   */
  newRecording(fromStart = false): void {
    const home = get().status?.target.frameUrl || get().status?.target.url || null;
    if (fromStart && home) {
      set({ recorder: { ...initialRecorder, startUrl: home } });
      this.bridge.goto(home);
      return;
    }
    set({ recorder: { ...initialRecorder, startUrl: get().app.url || null } });
  }

  /** Whether the app is on another page than its start page (by path and #route). */
  awayFromStart(): boolean {
    const home = get().status?.target.frameUrl || get().status?.target.url;
    const now = get().app.url;
    if (!home || !now) return false;
    const page = (u: string) => {
      try {
        const x = new URL(u);
        return `${x.pathname.replace(/\/+$/, '')}${x.hash.replace(/^#\/?$/, '')}`;
      } catch {
        return u;
      }
    };
    return page(home) !== page(now);
  }

  removeStep(i: number): void {
    const r = get().recorder;
    // A check said after this step stays after the steps that were before it.
    const expectations = r.expectations.map((e) => (e.after !== undefined && e.after > i ? { ...e, after: e.after - 1 } : e));
    set({ recorder: { ...r, steps: r.steps.filter((_, j) => j !== i), expectations, spec: null, run: null } });
  }

  /** The page a step led to while writing a test: the test waits for it before its next step. */
  private recordedPage(url: string): void {
    const r = get().recorder;
    if (get().mode !== 'record' || !r.startUrl) return;
    const path = (u: string) => {
      try {
        const x = new URL(u);
        return x.hash.startsWith('#/') ? x.hash.split('?')[0] : x.pathname;
      } catch {
        return u;
      }
    };
    const last = [...r.steps].reverse().find((s) => s.kind === 'url' || s.kind === 'goto')?.url ?? r.startUrl;
    if (path(url) === path(last) || !r.steps.length) return;
    set({ recorder: { ...r, steps: [...r.steps, { kind: 'url', url, description: `Wait for ${path(url)}` }] } });
  }

  /** Where a check said now goes: after the steps recorded so far, the text still being typed included. */
  private async checkPlace(): Promise<number> {
    await this.bridge.flushRecorder();
    return get().recorder.steps.length;
  }

  removeExpectation(i: number): void {
    const r = get().recorder;
    set({ recorder: { ...r, expectations: r.expectations.filter((_, j) => j !== i) } });
  }

  /** Reload the app on the page it is on (its route and #hash); a page that doesn't answer (stuck, or gone) loads afresh from the start. */
  async reloadApp(): Promise<void> {
    set({ hover: null });
    const { connected, url } = get().app;
    if (connected && url && (await this.bridge.reload(url))) return set({ app: { ...get().app, connected: false } });
    set({ app: { ...get().app, connected: false, reloadKey: get().app.reloadKey + 1 } });
  }

  // ───────────────────────────── voice ─────────────────────────────

  private applyVoiceSettings(): void {
    const v = settings().voice;
    this.voice.engine = v.engine;
    this.voice.lang = v.lang;
    this.voice.autoStopMs = v.autoStopMs;
    set({ voice: { ...get().voice, supported: this.voice.supported } });
  }

  private wireVoice(): void {
    const v = this.voice;
    v.asr.onChange = (model, modelError) => set({ voice: { ...get().voice, model, modelError } });
    v.onState = (state) => {
      const was = get().voice.state;
      set({ voice: { ...get().voice, state, ...(state === 'idle' ? { trigger: null, words: [], bindings: [] } : {}) } });
      // The cue says the microphone is really on: talk now.
      if (state === 'listening' && was !== 'listening') play('listen');
    };
    v.onWords = (words, aligned) => {
      set({ voice: { ...get().voice, words: words.map((w) => w.text), bindings: this.bind(words, aligned) } });
    };
    v.onFinal = (final) => {
      const last = { text: final.text, source: final.source, browser: final.browser, browserError: final.browserError, device: final.device, loudness: final.loudness, ms: final.ms };
      set({ voice: { ...get().voice, last } });
      const listening = this.talking();
      if (this.dryRun) {
        if (!listening && get().island.kind === 'listening') set({ island: { kind: 'idle' } });
        return this.dryRun(final.text, final);
      }
      if (!final.text.trim()) {
        if (!listening && get().island.kind === 'listening') set({ island: { kind: 'idle' } });
        return;
      }
      play('send');
      const spoken: Spoken = { words: final.words, aligned: final.aligned, span: final.span };
      if (settings().voice.review) return this.draftSpoken(final, spoken);
      void this.handleUtterance(final.text, spoken, 'voice');
    };
    v.onError = (_code, message) => {
      set({ voice: { ...get().voice, error: message } });
      play('error');
      this.notify(message, 'error');
    };
    v.onNothing = () => this.notify('Didn’t hear anything. Try again, a little closer to the mic.', 'info');
  }

  private bind(words: Word[], aligned = false): Binding[] {
    const s = get();
    // Recognisers report words a little after they are said; audio-aligned words need no correction.
    const lagMs = aligned ? 0 : DEFAULT_FUSION.lagMs;
    return resolveDeictics(words, this.track, { ...DEFAULT_FUSION, lagMs, pins: s.pins, selection: s.selection }).map((r) => ({ index: r.index, word: r.word, el: r.el, via: r.via }));
  }

  /** Review mode: what you said goes to the command bar, to fix if needed and send with Enter. */
  private draftSpoken(final: VoiceFinal, spoken: Spoken): void {
    this.drafted = spoken;
    const alternatives = [...new Set([...final.browser, final.device])].filter((t) => t && t !== final.text).slice(0, 3);
    if (get().island.kind === 'listening') set({ island: { kind: 'idle' } });
    set({ draft: { text: final.text, alternatives, n: (get().draft?.n ?? 0) + 1 } });
  }

  /** The command bar was submitted. A reviewed voice request keeps its timing, so “this” still means what you pointed at. */
  submitText(text: string): void {
    const t = text.trim();
    const spoken = this.drafted;
    this.clearDraft();
    if (!t) return;
    if (spoken) return void this.handleUtterance(t, { ...spoken, words: alignWords(t, spoken.span.start, spoken.span.end), aligned: true }, 'voice');
    void this.handleUtterance(t, null, 'typed');
  }

  clearDraft(): void {
    this.drafted = null;
    if (get().draft) set({ draft: null });
  }

  startTalk(trigger: 'hold' | 'toggle'): void {
    if (!this.voice.supported) {
      this.notify('Voice needs a microphone and Chrome, Edge or Safari. Type your request instead.', 'warn');
      set({ focusInput: get().focusInput + 1 });
      return;
    }
    if (this.talking()) return;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.applyVoiceSettings();
    set({ voice: { ...get().voice, trigger, words: [], bindings: [], error: null }, island: { kind: 'listening' } });
    void this.voice.start({ handsFree: trigger === 'toggle' });
  }

  stopTalk(): void {
    this.voice.stop();
  }

  cancelTalk(note?: string): void {
    this.voice.cancel();
    set({ voice: { ...get().voice, state: 'idle', trigger: null, words: [], bindings: [] } });
    if (note) this.notify(note, 'info');
    else if (get().island.kind === 'listening') set({ island: { kind: 'idle' } });
  }

  private talking(): boolean {
    const state = get().voice.state;
    return state === 'starting' || state === 'listening';
  }

  toggleTalk(): void {
    if (this.talking()) this.stopTalk();
    else this.startTalk('toggle');
  }

  /** Space or the mic button went down: hold to talk, tap for hands-free, press again to send. */
  pressTalk(): void {
    this.spaceDownAt = performance.now();
    if (this.talking() && get().voice.trigger === 'toggle') {
      this.spaceConsumed = true;
      this.stopTalk();
      return;
    }
    this.spaceConsumed = false;
    this.startTalk('hold');
  }

  releaseTalk(): void {
    if (!this.spaceDownAt) return;
    const held = performance.now() - this.spaceDownAt;
    this.spaceDownAt = 0;
    if (this.spaceConsumed) {
      this.spaceConsumed = false;
      return;
    }
    const v = get().voice;
    if (!this.talking() || v.trigger !== 'hold') return;
    if (held < 280) {
      // A quick tap switches to hands-free: it stops by itself when you pause.
      set({ voice: { ...v, trigger: 'toggle' } });
      this.voice.setHandsFree(true);
      return;
    }
    this.stopTalk();
  }

  // ───────────────────────────── keyboard ─────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    // A menu or dialog took the key (Escape closing it): it was for that layer alone.
    if (e.defaultPrevented) return;
    const s = get();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      set({ overlay: s.overlay === 'palette' ? null : 'palette' });
      return;
    }
    // The setup tour and the voice test in Settings let you try push-to-talk (unless Space is for a focused control).
    if ((s.overlay || modalOpen()) && !(e.code === 'Space' && this.dryRun && !isControl(e.target))) return;
    if (isTyping(e.target)) return;
    if (e.code === 'Space' && !mod && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) this.pressTalk();
      return;
    }
    if (e.repeat) return;
    if (e.key === 'Escape') return this.stop('key');
    if (e.key === 'Enter' && !mod && previews(s).length) {
      e.preventDefault();
      return void this.keep('key');
    }
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (previews(s).length) {
        e.preventDefault();
        void this.undo('key');
      }
      return;
    }
    if (mod || e.altKey) return;
    switch (e.key) {
      case '/':
        e.preventDefault();
        set({ focusInput: s.focusInput + 1 });
        return;
      case '?':
        set({ overlay: 'help' });
        return;
      case 'e':
      case 'E':
        return this.setMode('edit');
      case 'u':
      case 'U':
        return this.setMode('use');
      case 'r':
      case 'R':
        return this.setMode('record');
      case 'm':
      case 'M':
        if (sessions.recording) sessions.mark('', 'key');
        return;
      case '\\':
        settings().setUi({ panelOpen: !settings().ui.panelOpen });
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        // Move the selection: out, in, previous, next (not while a report is open over the app).
        if (s.selection && !useSessions.getState().open) {
          e.preventDefault();
          void this.step(({ ArrowUp: 'parent', ArrowDown: 'child', ArrowLeft: 'prev', ArrowRight: 'next' } as const)[e.key]);
        }
        return;
      case 'o':
      case 'O':
        if (s.selection) void this.openInEditor(s.selection);
        return;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code !== 'Space' || !this.spaceDownAt) return;
    e.preventDefault();
    this.releaseTalk();
  }

  // ───────────────────────────── commands ─────────────────────────────

  /** Something was said or typed. */
  async handleUtterance(text: string, spoken: Spoken | null, input: 'voice' | 'typed'): Promise<void> {
    const t = text.trim();
    if (!t) return;
    // Clicked and asked at once: the request is about what was clicked.
    if (this.picking) await this.picking;
    if (this.dryRun) {
      if (get().island.kind === 'listening') set({ island: { kind: 'idle' } });
      return this.dryRun(t);
    }
    const s = get();
    set({ history: [t, ...s.history.filter((h) => h !== t)].slice(0, 40) });
    // Said in Arabic: the studio's own command when it is one ("كبّر هذا" → "make this bigger"); otherwise Claude gets the Arabic as said.
    const arabic = arabicCommand(t);
    const said = arabic?.text ?? t;
    if (sessions.recording && (arabic?.kind === 'session' || /^(?:mark|flag|bookmark)(?: (?:this|that|it|here|the moment|this moment))?[.!]?$/i.test(t))) {
      if (get().island.kind === 'listening') set({ island: { kind: 'idle' } });
      sessions.mark(t, 'voice');
      return this.notify('Marked this moment.', 'ok');
    }
    const cmd = parseClientCommand(said, { hasFailingTest: s.recorder.run?.status === 'failed' && !!s.recorder.spec });
    sessions.command(t, input, cmd ? cmd.kind : arabic ? arabic.kind : 'request');
    if (cmd) {
      if (get().island.kind === 'listening') set({ island: { kind: 'idle' } });
      return this.runCommand(cmd, spoken);
    }
    if (s.mode === 'record') {
      const exp = parseExpectation(said);
      if (exp) return this.addExpectation(exp, spoken);
      // Shaped like a check, and not one the studio understands: never sent to the AI as a request for a change.
      if (looksLikeCheck(said)) {
        if (get().island.kind === 'listening') set({ island: { kind: 'idle' } });
        return this.notify(`That isn’t a check the studio understands. ${CHECK_PHRASES}`, 'warn');
      }
    }
    return this.sendIntent(said, spoken, input);
  }

  /** What “this” meant as you said it (not what is already selected), or what you pointed at meanwhile, or what is under the pointer. */
  private pointedAt(spoken: Spoken | null): ElementInfo | null {
    if (spoken?.words.length) {
      const lagMs = spoken.aligned ? 0 : DEFAULT_FUSION.lagMs;
      const bound = resolveDeictics(spoken.words, this.track, { ...DEFAULT_FUSION, lagMs, pins: [], selection: null }).find((r) => r.el);
      if (bound?.el) return bound.el;
      const dwell = this.pointedWhile(spoken);
      if (dwell) return dwell;
    }
    return get().hover;
  }

  /** What you pointed at while talking (from the start of speech until shortly after it ended). */
  private pointedWhile(spoken: Spoken): ElementInfo | null {
    return this.track.dwellWinner(spoken.span.start - 300, spoken.span.end + 150);
  }

  private targetFrom(spoken: Spoken | null): ElementInfo | null {
    const s = get();
    if (spoken?.words.length) {
      const bound = this.bind(spoken.words, spoken.aligned).find((b) => b.el);
      if (bound?.el) return bound.el;
      const dwell = this.pointedWhile(spoken);
      if (dwell) return dwell;
    }
    // Write test boxes what the pointer is on (a click there acts in the app, it doesn't select): a check typed is
    // about what it rested on when the command bar took the focus, else that, or what the mouse rested on just
    // before, not a selection left from Edit mode.
    if (s.mode === 'record') {
      if (s.typingAbout && !spoken?.words.length) return s.typingAbout;
      if (s.hover) return s.hover;
      const recent = this.track.dwellWinner(performance.now() - 5000, performance.now());
      if (recent) return recent;
    }
    if (s.selection) return s.selection;
    if (s.hover) return s.hover;
    return s.pins[0] ?? null;
  }

  private async runCommand(cmd: ClientCommand, spoken: Spoken | null): Promise<void> {
    switch (cmd.kind) {
      case 'keep':
        return this.keep('voice');
      case 'undo':
        return this.undo('voice');
      case 'cancel':
        return this.stop('voice');
      case 'parent':
        return this.selectParent();
      case 'nav':
        return this.step(cmd.to);
      case 'find': {
        const s = get();
        return this.selectCalled(cmd.what, cmd.where, s.selection ?? (spoken?.words.length ? this.pointedWhile(spoken) : null) ?? s.hover);
      }
      case 'clear':
        this.clearTargets();
        return this.notify('Nothing selected.', 'info');
      case 'mode':
        this.setMode(cmd.mode);
        return this.notify(cmd.mode === 'record' ? 'Recording. Use the app, then point at what’s wrong and say what it should show.' : `${cmd.mode === 'edit' ? 'Edit' : 'Use'} mode.`, 'info');
      case 'generate':
        return this.generateTest();
      case 'run':
        return this.runTest();
      case 'fix':
        return this.fix(spoken ? 'voice' : 'typed');
      case 'click': {
        const el = this.targetFrom(spoken);
        if (!el) return this.notify('Point at what to click while you say it.', 'info');
        await this.bridge.click(el.rect.x + el.rect.w / 2, el.rect.y + el.rect.h / 2);
        return;
      }
      case 'type': {
        const r = await this.bridge.type(cmd.text, cmd.submit);
        if (!r.ok) this.notify('Click a text field in the app first, then say “type …”.', 'info');
        return;
      }
      case 'scroll': {
        const g = this.geom();
        if (!g) return;
        const cx = g.w / g.scale / 2;
        const cy = g.h / g.scale / 2;
        const page = (g.h / g.scale) * 0.7;
        const dy = cmd.dir === 'down' ? page : cmd.dir === 'up' ? -page : cmd.dir === 'top' ? -1e6 : 1e6;
        this.bridge.scroll(cx, cy, 0, dy);
        return;
      }
      case 'reload':
        return this.reloadApp();
      case 'help':
        set({ overlay: 'help' });
        return;
      case 'open':
        return this.openInEditor(this.targetFrom(spoken));
      case 'select': {
        const el = this.pointedAt(spoken);
        if (el) this.select(el);
        else this.notify('Point at what to select while you say it.', 'info');
        return;
      }
      case 'add': {
        const el = this.pointedAt(spoken);
        if (el) this.toggleSelected(el);
        else this.notify('Point at what to add while you say it.', 'info');
        return;
      }
    }
  }

  /** Elements the request refers to, in the order the user mentioned them. */
  private refsFor(spoken: Spoken | null): { refs: RefInfo[]; els: ElementInfo[] } {
    const s = get();
    let picked: { el: ElementInfo; role: string }[] = [];
    if (spoken?.words.length) {
      picked = this.bind(spoken.words, spoken.aligned)
        .filter((b) => b.el)
        .map((b) => ({ el: b.el!, role: b.via === 'pin' ? `pin:${b.word}` : b.word }));
    }
    if (!picked.length) {
      // Spoken: what you pointed at while talking. Typed: what is under the pointer right now (e.g. after pressing /).
      const pointed = spoken?.words.length ? this.pointedWhile(spoken) : s.hover;
      const implicit = implicitTargets(s.pins, s.selection, pointed);
      picked = implicit.map((el, i) => ({ el, role: s.pins.length ? `pin ${i + 1}` : s.selection ? 'selection' : 'pointed' }));
    }
    const seen = new Set<number>();
    const unique = picked.filter((p) => (seen.has(p.el.id) && p.role === 'it' ? false : (seen.add(p.el.id), true)));
    return { refs: unique.map(({ el, role }) => refOf(el, role)), els: unique.map((p) => p.el) };
  }

  /**
   * The elements a request is about, as the page shows them now: an edit in an editor, or an undo, can change what an
   * element says (or which element a node is) while it stays selected. One that is gone is sent as it was.
   */
  private async freshRefs(spoken: Spoken | null): Promise<{ refs: RefInfo[]; els: ElementInfo[] }> {
    const { refs, els } = this.refsFor(spoken);
    const fresh = await Promise.all(els.map(async (el) => (await this.bridge.describe(el.id).catch(() => null)) ?? el));
    return { refs: refs.map((r, i) => (fresh[i] === els[i] ? r : refOf(fresh[i], r.role))), els: fresh };
  }

  private pointerKind(): 'mouse' | 'none' {
    return performance.now() - this.lastMouseAt < 5000 ? 'mouse' : 'none';
  }

  // Requests go one at a time: one asked while another runs waits its turn, shown in the island (core/requests.ts).
  private readonly requests = new RequestQueue({
    started: (request, fresh) => set({ request, ...(fresh ? { island: { kind: 'thinking' as const } } : {}) }),
    stopping: (id) => {
      const r = get().request;
      if (r?.id === id) set({ request: { ...r, step: 'Stopping', detail: undefined } });
    },
    ended: (id) => {
      if (get().request?.id === id) set({ request: null });
    },
    waiting: (waiting) => set({ waiting }),
    cancel: (id) => api.post('/cancel', { requestId: id }).catch(() => undefined),
    fail: (err) => this.fail(err),
  });
  /** Bumped when another app opens: what a request for the last one returns isn't shown here. */
  private appEpoch = 0;

  private ask(job: RequestJob): Promise<void> {
    const asked = this.requests.ask(job);
    if (asked) return asked;
    this.notify(`${MAX_WAITING} requests are already waiting. Let them finish, or press Esc to stop them.`, 'info');
    return Promise.resolve();
  }

  async sendIntent(text: string, spoken: Spoken | null, input: 'voice' | 'typed'): Promise<void> {
    const pointer = this.pointerKind();
    const { refs, els } = await this.freshRefs(spoken);
    return this.intent({ text, refs, els, input, pointer, pageUrl: get().app.url });
  }

  /** What it is about is taken when it is asked, not when its turn comes. */
  private intent(req: IntentAsk): Promise<void> {
    const epoch = this.appEpoch;
    return this.ask({
      text: req.text,
      kind: 'intent',
      step: 'Working',
      run: async (id, stopped) => {
        try {
          const res = await api.post<IntentResult>('/intent', { text: req.text, refs: req.refs, requestId: id, input: req.input, pointer: req.pointer, pageUrl: req.pageUrl, ...(req.ai ? { ai: true } : {}) });
          this.settle(id, res, req.text, req.els, { stopped: stopped(), epoch, again: () => void this.intent({ ...req, ai: true }), retry: () => void this.intent(req) });
        } finally {
          void this.refreshSummary();
        }
      },
    });
  }

  /**
   * A request's result. A change is in the files now, so it is always shown, even when the request was stopped
   * meanwhile; an answer or a message only while it is still wanted. Returns whether it was a change.
   */
  private settle(id: string, res: IntentResult, said: string, els: ElementInfo[], how: { stopped: boolean; epoch: number } & Ways): boolean {
    if (get().request?.id === id) set({ request: null });
    // Another app is open now: its change waits in that app's list, shown when it is opened again.
    if (how.epoch !== this.appEpoch) return false;
    if (res.kind === 'change') {
      this.applyResult(res, said, els);
      if (how.stopped) this.notify(`It was done before it could stop: “${res.change.title}” is a preview now. Keep or undo it.`, 'info');
      return true;
    }
    if (!how.stopped) this.applyResult(res, said, els, how);
    return false;
  }

  private applyResult(res: IntentResult, said: string, els: ElementInfo[], ways: Ways = {}): void {
    switch (res.kind) {
      case 'change': {
        this.upsertChange(res.change);
        const pts = els.map((el) => ({ changeId: res.change.id, el }));
        set({ previewTargets: [...get().previewTargets, ...pts].slice(-8), island: { kind: 'idle' } });
        this.refreshAfterEdit();
        return;
      }
      case 'answer':
        set({ island: { kind: 'answer', text: res.text, said, model: res.model, latencyMs: res.latencyMs } });
        return;
      case 'message':
        if (res.tone === 'error') play('error');
        return this.notify(res.text, res.tone === 'error' ? 'error' : res.tone === 'warn' ? 'warn' : 'info', this.nextActions(res.next, ways));
      case 'needs-key':
        set({ island: { kind: 'needs-key', text: res.text, actions: this.nextActions(res.next, ways) } });
        return;
    }
  }

  /** The way forward a refusal offers, as the island's buttons. */
  private nextActions(next: NextStep[] | undefined, { again, retry }: Ways = {}): IslandAction[] | undefined {
    const actions = (next ?? []).flatMap((n): IslandAction[] => {
      switch (n.kind) {
        case 'ask-ai': {
          const who = aiName(get().status?.ai.who);
          return again ? [{ label: who === 'AI' ? 'Ask the AI anyway' : `Ask ${who} anyway`, primary: true, run: () => (this.dismissIsland(), again()) }] : [];
        }
        case 'retry':
          return retry ? [{ label: 'Ask again', primary: true, run: () => (this.dismissIsland(), retry()) }] : [];
        case 'connect-ai':
          return [{ label: 'Connect an AI', primary: true, run: () => set({ overlay: 'settings', settingsTab: 'ai', island: { kind: 'idle' } }) }];
        case 'link-folder':
          return [{ label: 'Link its folder…', primary: true, run: () => (this.dismissIsland(), apps.show('folder', useApps.getState().active ?? undefined)) }];
        case 'open': {
          const at = /^(.+?):(\d+)(?::\d+)?$/.exec(n.src);
          if (!at || !get().status?.target.root) return [];
          return [{ label: at[2] === '1' ? `Open ${fileName(at[1])}` : `Open ${fileName(at[1])}:${at[2]}`, run: () => this.openRelative(at[1], Number(at[2])) }];
        }
      }
    });
    return actions.length ? actions : undefined;
  }

  private upsertChange(c: Change): void {
    const list = get().changes.filter((x) => x.id !== c.id);
    set({ changes: [c, ...list] });
  }

  /** Keep what waits: every preview, or (from the Changes tab) one change with the older ones it builds on. */
  async keep(via: string, id?: string): Promise<void> {
    if (!id && !previews(get()).length) return this.notify('Nothing is waiting to be kept.', 'info');
    try {
      const r = await api.post<{ kept: Change[]; committed: boolean; commitError?: string }>('/changes/keep', { id, via, commit: settings().ui.commitOnKeep });
      play('keep');
      await this.decided(r.kept);
      const what = r.kept.length === 1 ? r.kept[0].title : `${r.kept.length} changes`;
      if (r.commitError) this.notify(`Kept: ${what}, but not committed. Git said: ${r.commitError}`, 'warn');
      else this.notify(`Kept: ${what}${r.committed ? ' (committed)' : ''}`, 'ok');
    } catch (err) {
      this.fail(err);
    }
  }

  /** Undo the newest preview, or (from the Changes tab) one change with the newer ones built on it. */
  async undo(via: string, force = false, id?: string): Promise<void> {
    if (!id && !previews(get()).length) return this.notify('Nothing to undo.', 'info');
    try {
      const r = await api.post<{ undone: Change[] }>('/changes/undo', { id, via, force });
      play('undo');
      await this.decided(r.undone);
      this.notify(r.undone.length === 1 ? `Undone: ${r.undone[0].title}` : `Undid ${r.undone.length} changes.`, 'info');
      this.refreshAfterEdit();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        play('error');
        set({
          island: {
            kind: 'message',
            tone: 'warn',
            text: err.message,
            sticky: true,
            actions: [
              { label: 'Undo anyway', run: () => void this.undo(via, true, id) },
              { label: 'Leave it', run: () => set({ island: { kind: 'idle' } }) },
            ],
          },
        });
        return;
      }
      this.fail(err);
    }
  }

  /** What was kept or undone is no longer boxed as a preview, and the change list and the stats catch up. */
  private async decided(changes: Change[]): Promise<void> {
    const ids = new Set(changes.map((c) => c.id));
    set({ previewTargets: get().previewTargets.filter((p) => !ids.has(p.changeId)), recorder: { ...get().recorder, verifying: false } });
    await this.refreshChanges();
    void this.refreshSummary();
  }

  undoChange(id: string): Promise<void> {
    return this.undo('panel', false, id);
  }

  keepChange(id: string): Promise<void> {
    return this.keep('panel', id);
  }

  /** Open palm, Escape, "cancel": stop whatever is happening, one layer at a time. */
  stop(_via: string): void {
    const s = get();
    if (this.replayer.running) return this.replayer.stop();
    if (this.autopilot.running) return this.autopilot.stop();
    if (s.voice.state !== 'idle') return this.cancelTalk();
    if (s.request) return void this.cancelRequest();
    if (s.island.kind !== 'idle') return set({ island: { kind: 'idle' } });
    if (s.selection || s.pins.length) return this.clearTargets();
  }

  /** Stop the running request; the ones waiting after it aren't sent. */
  async cancelRequest(): Promise<void> {
    const dropped = this.requests.stop();
    if (dropped === null) return;
    this.notify(dropped ? `Stopped. ${dropped === 1 ? 'The request waiting after it wasn’t sent.' : `The ${dropped} requests waiting after it weren’t sent.`}` : 'Stopped.', 'info');
  }

  dismissIsland(): void {
    set({ island: { kind: 'idle' } });
  }

  notify(text: string, tone: Tone = 'info', actions?: IslandAction[]): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    const island = { kind: 'message' as const, text, tone, actions };
    set({ island });
    if (!actions?.length) {
      this.noticeTimer = setTimeout(() => {
        if (get().island === island) set({ island: { kind: 'idle' } });
      }, tone === 'error' ? 7000 : tone === 'warn' ? 6000 : 3800);
    }
  }

  private fail(err: unknown): void {
    play('error');
    this.notify(err instanceof Error ? err.message : String(err), 'error');
  }

  // ───────────────────────────── narrate a bug → test ─────────────────────────────

  /**
   * The command bar took the focus (clicked, or “/”): in Write test, what the pointer rests on (or rested on just
   * before) is what a check typed there is about, however long the typing takes. It stays until the bar loses focus.
   */
  barFocused(): void {
    const s = get();
    if (s.mode !== 'record') return;
    const about = s.hover ?? this.track.dwellWinner(performance.now() - 5000, performance.now());
    set({ typingAbout: about ?? null, ...(about ? { hover: about } : {}) });
  }

  barBlurred(): void {
    if (get().typingAbout) set({ typingAbout: null });
  }

  /** When the last step was recorded (or Write test began): how long a tester waited before saying a check. */
  private stepAt = 0;

  private async addExpectation(exp: SpokenExpectation, spoken: Spoken | null): Promise<void> {
    const saidAt = spoken?.span.start ?? performance.now();
    const el = this.targetFrom(spoken);
    if (!el) return this.notify('Point at the element that shows the wrong value while you say it.', 'warn');
    const found = await this.checkOf(el, exp.expected, { not: exp.not, state: exp.state });
    if (typeof found === 'string') return this.notify(found, 'warn');
    if (!found) return this.notify('Couldn’t build a locator for that element. Try pointing at it again.', 'warn');
    // “Paid, not yet” said of an element that shows “Paid, not yet”: those words are the value, not a value and an aside.
    const words = exp.whole && !found.field && showsValue(found.actual, exp.whole) ? { ...found, ...asShown(found.actual, exp.whole) } : found;
    // What came after a wait (a result that took 12 s) is waited for as long in the test.
    const waited = this.stepAt ? Math.round(saidAt - this.stepAt) : 0;
    const e = waited > 0 ? { ...words, waited } : words;
    const r = get().recorder;
    set({ recorder: { ...r, expectations: [...r.expectations, e], spec: null, run: null } });
    play('keep');
    const now = e.field === 'checked' || e.field === 'state' ? (e.actual ? `, it is ${e.actual}` : '') : e.actual ? `, it shows “${focusOn(e.actual, e.expected)?.slice(0, 40)}”` : '';
    this.notify(`Check added: ${e.description} ${shouldBe(e)}${now}.`, 'ok', [
      { label: 'Generate test', primary: true, run: () => void this.generateTest() },
      { label: 'Add another', run: () => this.dismissIsland() },
    ]);
  }

  /** From the Test tab: add a check for the selected element. */
  async addExpectationFor(el: ElementInfo, expected: string): Promise<void> {
    const e = await this.checkOf(el, expected);
    if (typeof e === 'string') return this.notify(e, 'warn');
    if (!e) return this.notify('Couldn’t build a locator for that element.', 'warn');
    const r = get().recorder;
    set({ recorder: { ...r, expectations: [...r.expectations, e], spec: null, run: null } });
  }

  /**
   * A check that `el` should show `expected`, found by what doesn't change with the fix. Said of a checkbox, a radio
   * button or a switch (or its label) as “checked” or “not checked”, it checks that; said of an option of a list as
   * “selected”, that the list has it chosen; of a tab as “selected”, that it is. `how.state`: visible, hidden,
   * enabled or disabled. `how.not`: the value must not be there. A sentence (to say, not a check) when the element
   * can't be what was said: a paragraph is never disabled, a heading never checked.
   */
  private async checkOf(el: ElementInfo, expected: string, how: { not?: boolean; state?: 'visible' | 'hidden' | 'enabled' | 'disabled' } = {}): Promise<Expectation | string | null> {
    const what = el.text ? `“${el.text.slice(0, 40)}”` : 'That';
    if (how.state) {
      if ((how.state === 'enabled' || how.state === 'disabled') && !canDisable(el)) return `${what} can’t be ${how.state}: only a button, a field, a list or another control can. Point at the control.`;
      const loc = await this.bridge.locator(el.id);
      if (!loc) return null;
      // Pointed at, it is on screen; whether it is enabled isn't known here.
      return { locator: loc.locator.code, description: loc.locator.description, expected: how.state, actual: how.state === 'visible' || how.state === 'hidden' ? 'visible' : '', after: await this.checkPlace(), field: 'state' };
    }
    const state = stateWord(expected);
    if (state && !how.not) {
      const loc = await this.bridge.locator(el.id, { expected, state: true });
      if (!loc) return null;
      const after = await this.checkPlace();
      const base = { locator: loc.locator.code, description: loc.locator.description, after };
      if (loc.checked !== undefined) return { ...base, expected: state, actual: loc.checked ? 'checked' : 'not checked', field: 'checked' };
      if (state === 'checked' && loc.option && loc.chosen) return { ...base, expected: loc.option, actual: loc.chosen.join(', '), field: 'select' };
      // A tab, an option of a listbox, a row of a grid: selected is aria-selected.
      if (SELECTABLE.has(el.role ?? '')) {
        const plain = await this.bridge.locator(el.id);
        if (!plain) return null;
        return { locator: plain.locator.code, description: plain.locator.description, after, expected: state === 'checked' ? 'selected' : 'not selected', actual: '', field: 'state' };
      }
      // “on” and “off” are also words an element shows (a status that says “Off”); the others only ever a state.
      if (!/^(?:on|off)$/i.test(expected.trim())) return `${what} can’t be ${state}: it isn’t a checkbox, a radio button, a switch, an option of a list or a tab. To check its words, say “this should show …”.`;
    }
    // A list (or a label holding one, from a studio that points at labels): the option chosen, not every option's words.
    if (el.tag === 'select' || el.tag === 'label') {
      const list = await this.bridge.locator(el.id, { expected, state: true });
      if (list?.chosen) return { locator: list.locator.code, description: list.locator.description, expected, actual: list.chosen.join(', '), after: await this.checkPlace(), field: 'select', ...(how.not ? { not: true } : {}) };
    }
    // Found by what it won't show once fixed: for “shouldn't show $51.71”, not by the $51.71 it shows now.
    const loc = await this.bridge.locator(el.id, { expected: how.not ? '' : expected });
    if (!loc) return null;
    const after = await this.checkPlace();
    // An image says what it is by its name (its alt text), never by text inside it.
    const image = el.tag === 'img' || el.role === 'img';
    const actual = image ? el.label.split(' · ').slice(1).join(' · ') : loc.locator.text;
    // Words as the element shows them (“Free shipping” for “free shipping”), or compared without case when it doesn't.
    const words = asShown(actual, expected);
    return { locator: loc.locator.code, description: loc.locator.description, ...words, actual, after, ...(image ? { field: 'name' as const } : fieldOf(el)), ...(how.not ? { not: true } : {}) };
  }

  // ───────────────────────────── from a session report ─────────────────────────────

  /** The elements a finding is about: what was pointed at while it was said, or where it happened. */
  private findingTargets(items: TimelineItem[], a: SessionAnalysis): SessionTarget[] {
    const out: SessionTarget[] = [];
    for (const it of items) {
      const seg = it.kind === 'speech' ? a.transcript.find((s) => s.start === it.t) : null;
      const issue = it.issue ? a.issues.find((g) => g.id === it.issue) : null;
      const el = seg?.el ?? issue?.el;
      if (el && !out.some((o) => o.src === el.src && o.label === el.label)) out.push(el);
    }
    return out.slice(0, 4);
  }

  /** "Fix with Claude" on a finding: ask for the change with the session's evidence, then show it as a preview. */
  async fixFromReport(f: ReportFinding, items: TimelineItem[], a: SessionAnalysis): Promise<void> {
    const targets = this.findingTargets(items, a);
    const refs: RefInfo[] = targets.map((el) => ({ role: 'finding', src: el.src, name: el.name, label: el.label, text: el.text, tag: el.tag, hint: el.hint }));
    const text = [`Fix this problem found in a test session: ${f.title}.`, ...findingBrief(f, items)].join('\n');
    settings().setUi({ panelOpen: true, panelTab: 'changes' });
    const epoch = this.appEpoch;
    await this.ask({
      text: `Fix: ${f.title}`,
      kind: 'fix',
      step: 'Working',
      run: async (id, stopped) => {
        const res = await api.post<IntentResult>('/intent', { text: text.slice(0, 1990), refs, requestId: id, input: 'typed', pointer: 'none', pageUrl: get().app.url });
        this.settle(id, res, f.title, [], { stopped: stopped(), epoch, retry: () => void this.fixFromReport(f, items, a) });
      },
    });
  }

  /**
   * “Fix all” in a report: every finding the tester didn't set aside, in one
   * request, each with its evidence, so related problems get fixed together.
   */
  async fixFindings(findings: { f: ReportFinding; items: TimelineItem[] }[], a: SessionAnalysis): Promise<void> {
    if (!findings.length) return;
    const refs: RefInfo[] = [];
    const brief = findings
      .map(({ f, items }, i) => {
        for (const el of this.findingTargets(items, a)) if (refs.length < 8 && !refs.some((r) => (r.src ?? r.label) === (el.src ?? el.label))) refs.push({ role: 'finding', src: el.src, name: el.name, label: el.label, text: el.text, tag: el.tag, hint: el.hint });
        return [`${i + 1}. [${f.severity}] ${f.title}`, ...findingBrief(f, items).map((l) => `   ${l}`)].join('\n');
      })
      .join('\n\n');
    const n = findings.length;
    await this.reportTask(`Fix ${n === 1 ? 'this problem' : `these ${n} problems`} found in a test session.`, brief, refs, n === 1 ? `Fix: ${findings[0].f.title}` : `Fix ${n} findings`);
  }

  /** The suggestions the tester picked from a report, implemented in one request. */
  async implementSuggestions(picked: ReportSuggestion[], report: SessionReport): Promise<void> {
    if (!picked.length) return;
    const brief = [
      `The session: ${report.title}. ${report.summary}`,
      '',
      ...picked.map((x, i) => `${i + 1}. (${x.kind}, ${x.effort} effort) ${x.title}: ${x.why}`),
    ].join('\n');
    const n = picked.length;
    await this.reportTask(`Implement ${n === 1 ? 'this suggestion' : `these ${n} suggestions`} from a test session report.`, brief, [], n === 1 ? picked[0].title : `${n} suggestions`);
  }

  /** Select an element an expert's finding is about, scrolled into view. */
  async reveal(el: ElementInfo): Promise<ElementInfo | null> {
    if (get().mode !== 'edit') this.setMode('edit');
    const fresh = await this.bridge.reveal(el.id, el.src, el.index);
    if (fresh) this.select(fresh);
    return fresh;
  }

  /** Fix an expert's findings together: one request with each finding's evidence and the elements it is about. */
  async fixReview(items: { rule: string; title: string; what: string; fix: string; els?: ElementInfo[]; rewrite?: { before: string; after: string } }[], expert: string): Promise<void> {
    if (!items.length) return;
    const refs: RefInfo[] = [];
    for (const it of items) for (const el of it.els ?? []) if (refs.length < 8 && !refs.some((r) => (r.src ?? r.label) === (el.src ?? el.label))) refs.push({ role: 'finding', src: el.src, name: el.name, label: el.label, text: el.text, tag: el.tag, hint: el.hint, frames: el.frames });
    const brief = items
      .map((it, i) => `${i + 1}. [${it.rule}] ${it.title}\n   Found: ${it.what}\n   Fix: ${it.fix}${it.rewrite ? `\n   Change the text “${it.rewrite.before}” to “${it.rewrite.after}”.` : ''}`)
      .join('\n');
    const label = items.length === 1 ? `Fix: ${items[0].title}` : `Fix ${items.length} ${expert} findings`;
    // At the root: one design token or shared style that fails fixes every element using it, not just those named.
    await this.reportTask(
      `Fix these ${expert} findings from the studio's page review. Fix each at its root: when the elements share a design token, style or component (one colour, one size), change that once so every use is fixed; the elements named are examples. Otherwise make the smallest change that satisfies the rule.`,
      brief,
      refs,
      label,
    );
  }

  private async reportTask(text: string, brief: string, refs: RefInfo[], label: string): Promise<void> {
    settings().setUi({ panelOpen: true, panelTab: 'changes' });
    const epoch = this.appEpoch;
    await this.ask({
      text: label,
      kind: 'fix',
      step: 'Working',
      run: async (id, stopped) => {
        const res = await api.post<IntentResult>('/intent', { text, brief: brief.slice(0, 16_000), refs, requestId: id, input: 'typed', pointer: 'none', pageUrl: get().app.url });
        this.settle(id, res, label, [], { stopped: stopped(), epoch, retry: () => void this.reportTask(text, brief, refs, label) });
      },
    });
  }

  /** Autopilot: the AI uses the app and says what is wrong, in a test session of its own that ends in a report. */
  async startAutopilot(opts: AutopilotOptions): Promise<void> {
    if (this.autopilot.running || this.replayer.running) return;
    if (!get().app.connected) return this.notify('Open your app first: Autopilot uses it here, in the studio.', 'info');
    if (!get().status?.ai.ready) {
      return this.notify('Autopilot needs an AI to decide what to try.', 'info', [{ label: 'Connect an AI', primary: true, run: () => set({ overlay: 'settings', settingsTab: 'ai', island: { kind: 'idle' } }) }]);
    }
    sessions.closeReport();
    if (sessions.recording) await sessions.stop();
    await this.autopilot.run(opts);
  }

  /** Replay & verify: play the session's steps again in the app (back on the stage), then compare. */
  async verifySession(d: SessionDetail): Promise<void> {
    if (this.replayer.running) return;
    if (!d.analysis?.steps.some((s) => s.kind !== 'navigate' && s.locator)) return this.notify('This session has no steps to replay.', 'info');
    sessions.closeReport();
    if (sessions.recording) await sessions.stop();
    await this.replayer.run(d);
  }

  /** "Create test" on a finding: the session's steps up to that moment, plus the expected value when one was said. */
  async testFromReport(f: ReportFinding, items: TimelineItem[], a: SessionAnalysis, appUrl: string): Promise<void> {
    // The value as the replay checks it: from the words said about an element, on that element; else on an element
    // the finding's expected value is named after.
    const check = findingCheck(f, a) ?? namedCheck(f, a);
    // The steps up to the moment the check is about (not on to a payment made after it); without one, up to the last
    // of the evidence.
    const steps = stepsOf(a, check ? check.t + 1000 : items.length ? items[items.length - 1].t + 1000 : Infinity);
    const startUrl = a.steps.find((s) => s.kind === 'navigate')?.url ?? appUrl;
    const expectations: Expectation[] = [];
    if (check) expectations.push({ locator: check.locator, description: check.el.description ?? check.el.label, expected: check.expected, actual: check.el.text, after: steps.length, ...fieldOf(check.el) });
    set({ recorder: { ...initialRecorder, startUrl, steps, expectations } });
    settings().setUi({ panelOpen: true, panelTab: 'test' });
    if (expectations.length) await this.generateTest();
    else this.notify(`Loaded ${steps.length} steps from the session. Now point at the value that is wrong and say what it should show, or add a check in the Test tab.`, 'info');
  }

  /** "Add a check" on a report: the session's steps, recording, ready for “this should show …” on a value that must be right. */
  checkSession(a: SessionAnalysis, appUrl: string): void {
    const steps = stepsOf(a);
    set({ recorder: { ...initialRecorder, startUrl: a.steps.find((s) => s.kind === 'navigate')?.url ?? appUrl, steps } });
    this.setMode('record');
    settings().setUi({ panelOpen: true, panelTab: 'test' });
    this.notify(`Loaded ${steps.length} steps from the session. Point at a value that must be right, like a total, and say what it should show.`, 'info', [{ label: 'Got it', run: () => this.dismissIsland() }]);
  }

  async generateTest(): Promise<void> {
    const r = get().recorder;
    if (!r.expectations.length) {
      settings().setUi({ panelOpen: true, panelTab: 'test' });
      return this.notify('First say what you expected: point at the wrong value and say “this should show …”.', 'info');
    }
    try {
      const spec = await api.post<{ path: string; code: string }>('/tests/generate', {
        startUrl: r.startUrl ?? get().app.url,
        steps: r.steps,
        expectations: r.expectations,
        // Written again (another check, a step taken out): this test's file, if it is as the studio wrote it.
        ...(r.spec || r.written ? { replace: r.spec ?? r.written } : {}),
      });
      // A test the studio wrote anew: its first run is judged on its own, not against the one that failed before.
      set({ recorder: { ...get().recorder, spec, written: spec, run: null, baseline: undefined } });
      settings().setUi({ panelOpen: true, panelTab: 'test' });
      this.notify(`Test saved to ${spec.path}.`, 'ok', [{ label: 'Run it', primary: true, run: () => void this.runTest() }]);
    } catch (err) {
      this.fail(err);
    }
  }

  async runTest(): Promise<void> {
    let spec = get().recorder.spec;
    if (!spec) {
      if (!get().recorder.expectations.length) return this.notify('Record a bug first: switch to Record mode, use the app, then say what you expected.', 'info');
      await this.generateTest();
      spec = get().recorder.spec;
      if (!spec) return;
    }
    if (get().recorder.running || this.requests.has('test')) return;
    const path = spec.path;
    await this.ask({ text: `Run ${path}`, kind: 'test', step: 'Running the test', run: (id) => this.testRun(id, path) });
  }

  private async testRun(id: string, path: string): Promise<void> {
    set({ recorder: { ...get().recorder, running: true } });
    // Once it has failed, every run is compared with the test that failed: a test changed since then (by hand, by an
    // AI request, by a fix) proves nothing by passing.
    const { verifying, baseline } = get().recorder;
    let res: TestRunResult;
    try {
      res = await api.post<TestRunResult>('/tests/run', { path, ...(baseline ? { baseline } : {}) });
    } catch (err) {
      res = { status: 'error', durationMs: 0, message: err instanceof Error ? err.message : String(err) };
    }
    // Said once: the next run judges the test as it is now.
    const changed = !!baseline && !!res.hash && res.hash !== baseline;
    set({ recorder: { ...get().recorder, running: false, run: { ...res, at: Date.now() }, ...(changed && res.status === 'passed' ? { baseline: undefined } : {}) } });
    if (get().request?.id === id) set({ request: null });
    void this.refreshSummary();
    const details = { label: 'Details', run: () => (settings().setUi({ panelOpen: true, panelTab: 'test' }), this.dismissIsland()) };
    const counted = res.counts ? `${plural(res.counts.steps, 'step')} and ${plural(res.counts.checks, 'check')}` : 'its steps and checks';
    switch (res.status) {
      case 'passed': {
        const fixing = verifying && previews(get()).length > 0;
        set({ recorder: { ...get().recorder, verifying: false } });
        if (!res.verified) {
          // It passed, but the run can't show what a pass should: said as it is, never as a success.
          play('error');
          set({
            island: {
              kind: 'message',
              tone: 'warn',
              sticky: true,
              text: fixing ? `Couldn’t verify the fix. ${res.unverified ?? ''}` : `Couldn’t verify. ${res.unverified ?? ''}`,
              actions: fixing ? [{ label: 'Keep anyway', run: () => void this.keep('test') }, { label: 'Undo fix', primary: true, run: () => void this.undo('test') }, details] : [details],
            },
          });
          return;
        }
        play('keep');
        if (fixing) {
          set({
            island: {
              kind: 'message',
              tone: 'ok',
              sticky: true,
              text: `The test passes with this fix: all ${counted} ran. Keep it?`,
              actions: [
                { label: 'Keep fix', primary: true, run: () => void this.keep('test') },
                { label: 'Undo', run: () => void this.undo('test') },
              ],
            },
          });
        } else this.notify(`Test passed in ${(res.durationMs / 1000).toFixed(1)} s: all ${counted} ran.`, 'ok');
        return;
      }
      case 'failed': {
        play('error');
        const wasFixing = verifying && previews(get()).length > 0;
        // The test that failed is the baseline the next fix is checked against.
        set({ recorder: { ...get().recorder, verifying: false, baseline: res.hash } });
        const fixWith = { label: `Fix with ${aiName(get().status?.ai.who)}`, primary: true, run: () => void this.fix() };
        if (res.failedAt === 'replay') {
          // The check held on screen as it was said: the test, not the app, differs from what was done.
          set({
            island: {
              kind: 'message',
              tone: 'warn',
              sticky: true,
              text: `The test doesn’t replay what you did: a step is missing or the page starts differently. When you said it, the page showed “${res.expected ?? '?'}”; the run saw “${res.received ?? '?'}”.`,
              actions: [details],
            },
          });
          return;
        }
        if (res.failedAt === 'find') {
          const check = res.steps?.find((x) => !x.ok);
          set({
            island: {
              kind: 'message',
              tone: 'warn',
              sticky: true,
              text: `${wasFixing ? 'With the fix, the test' : 'The test'} couldn’t find what ${check ? `“${check.title.replace(/^\[check \d+\] /, '')}”` : 'a check'} looks at (${/strict mode|resolved to \d+ elements/i.test(check?.error ?? '') ? 'more than one element matches' : 'nothing matches'}), so it doesn’t show the bug yet.`,
              actions: [details, { ...fixWith, primary: false, label: `Fix with ${aiName(get().status?.ai.who)} anyway` }],
            },
          });
          return;
        }
        if (res.failedAt === 'step') {
          // It never got to its checks: it doesn't show the bug (a step that can't be done, a page that didn't come).
          const step = res.steps?.find((x) => !x.ok);
          const elsewhere = /^The test didn’t get to the page it starts on[^.]*/.exec(res.message ?? '')?.[0];
          if (elsewhere) {
            set({ island: { kind: 'message', tone: 'warn', sticky: true, text: `${elsewhere}, so it doesn’t show the bug yet. A test starts in a fresh browser, signed out: start it from the sign-in page and sign in as part of it.`, actions: [details] } });
            return;
          }
          const why = (step?.error ?? res.message ?? '').split('\n')[0].slice(0, 160);
          set({
            island: {
              kind: 'message',
              tone: 'warn',
              sticky: true,
              text: `${wasFixing ? 'With the fix, the test' : 'The test'} didn’t reach its checks, so it doesn’t show the bug yet: ${step ? step.title.replace(/^\[\d+\] /, '') : 'a step'} failed${why ? ` (${why})` : ''}.`,
              actions: [details, { ...fixWith, primary: false, label: `Fix with ${aiName(get().status?.ai.who)} anyway` }],
            },
          });
          return;
        }
        set({
          island: {
            kind: 'message',
            tone: 'error',
            sticky: true,
            text: `${wasFixing ? 'Still failing with the fix: expected' : 'Test failed: expected'} “${res.expected ?? '?'}”, got “${res.received ?? '?'}”.`,
            actions: [fixWith, details],
          },
        });
        return;
      }
      case 'setup-needed':
        set({ recorder: { ...get().recorder, verifying: false } });
        set({
          island: {
            kind: 'message',
            tone: 'warn',
            sticky: true,
            text: res.message ?? 'Playwright needs a one-time setup.',
            actions: res.missingSecrets?.length
              ? [{ label: 'Open the Test tab', primary: true, run: () => (settings().setUi({ panelOpen: true, panelTab: 'test' }), this.dismissIsland()) }]
              : /Chromium/.test(res.message ?? '')
                ? [{ label: 'Install test browser', primary: true, run: () => void this.installBrowser() }]
                : [details],
          },
        });
        return;
      default:
        play('error');
        set({ recorder: { ...get().recorder, verifying: false } });
        this.notify(res.message ?? 'The test couldn’t run.', 'error');
    }
  }

  /** Ask the AI to fix what the failing test shows: by voice, typed, or (no `input`) with a button. */
  async fix(input?: 'voice' | 'typed'): Promise<void> {
    const r = get().recorder;
    if (!r.spec || r.run?.status !== 'failed') return this.notify('Run a failing test first, then ask for a fix.', 'info');
    const body = { path: r.spec.path, failure: r.run.message ?? '', input };
    const baseline = r.run.hash;
    const epoch = this.appEpoch;
    await this.ask({
      text: 'Fix the bug this test shows',
      kind: 'fix',
      step: 'Reading the failing test',
      run: async (id, stopped) => {
        const res = await api.post<IntentResult>('/fix', { ...body, requestId: id });
        if (!this.settle(id, res, 'fix it', [], { stopped: stopped(), epoch, retry: () => void this.fix(input) }) || stopped()) return;
        if (res.kind !== 'change') return;
        set({ recorder: { ...get().recorder, verifying: true, baseline } });
        // Check the fix against the same test straight away.
        setTimeout(() => void this.runTest(), 500);
      },
    });
  }

  async installBrowser(): Promise<void> {
    set({ recorder: { ...get().recorder, installing: true, installLog: [] }, island: { kind: 'idle' } });
    settings().setUi({ panelOpen: true, panelTab: 'test' });
    try {
      const { ok } = await api.post<{ ok: boolean }>('/tests/install');
      this.notify(ok ? 'Test browser installed. Run the test again.' : 'The install failed. See the log in the Test tab.', ok ? 'ok' : 'error', ok ? [{ label: 'Run test', primary: true, run: () => void this.runTest() }] : undefined);
    } catch (err) {
      this.fail(err);
    } finally {
      set({ recorder: { ...get().recorder, installing: false } });
    }
  }

  // ───────────────────────────── server state ─────────────────────────────

  /** Another app (or address) is open now: nothing shown for the last one still applies. */
  /** Write test's steps and checks so far, kept in this tab: a reload, or a studio that restarts, doesn't lose them. */
  private keeping: { app: string; save: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

  /**
   * The test being written is kept for each app (in this tab, by the app's id), with whether Write test was on: it
   * comes back whenever that app is opened again, after a reload, a restart of the studio, or another app.
   */
  private keepRecorder(): void {
    const app = useApps.getState().active;
    // Another app's test still waiting to be kept is kept now, before this one's.
    if (this.keeping && this.keeping.app !== app) this.keeping.save();
    if (this.keeping) clearTimeout(this.keeping.timer);
    this.keeping = null;
    if (!app) return;
    // Read now: by the time it is written, another app may be open.
    const { startUrl, steps, expectations, spec, run, baseline, written, elsewhere } = get().recorder;
    const recording = get().mode === 'record';
    const save = () => {
      try {
        if (!steps.length && !expectations.length && !spec) sessionStorage.removeItem(recorderKey(app));
        else sessionStorage.setItem(recorderKey(app), JSON.stringify({ recorder: { startUrl, steps, expectations, spec, run, baseline, written, elsewhere }, recording }));
      } catch {
        /* storage full or off: only this convenience is lost */
      }
    };
    this.keeping = {
      app,
      save,
      timer: setTimeout(() => {
        this.keeping = null;
        save();
      }, 300),
    };
  }

  /** The test kept for this app, back (unless one is being written already), and Write test on again if it was. */
  private restoreRecorder(app: string | null): void {
    if (!app) return;
    try {
      let saved = JSON.parse(sessionStorage.getItem(recorderKey(app)) ?? 'null') as { recorder?: Partial<RecorderState>; recording?: boolean } | null;
      // What an earlier studio kept, for the one app it was open on.
      const older = JSON.parse(sessionStorage.getItem(RECORDER_KEY) ?? 'null') as { app?: string; recorder?: Partial<RecorderState> } | null;
      if (!saved && older?.app === app) saved = { recorder: older.recorder };
      if (older?.app === app) sessionStorage.removeItem(RECORDER_KEY);
      const r = get().recorder;
      if (!saved?.recorder || r.steps.length || r.expectations.length) return;
      set({ recorder: { ...initialRecorder, ...saved.recorder, running: false, installing: false, installLog: [], verifying: false } });
      if (saved.recording) this.setMode('record');
      // The app's first page tells whether the steps still fit (checkKeptSteps); if it is already showing, now.
      if (this.pageSeen && get().app.connected) this.checkKeptSteps(get().app.url);
    } catch {
      /* nothing kept */
    }
  }

  /**
   * Kept steps that end on another page than the one the app is on now (it came back on its start page after a reload):
   * the Test tab says so, and keeps them until the person starts over or carries on regardless.
   */
  private checkKeptSteps(url: string): void {
    const r = get().recorder;
    if (!r.steps.length || !url) return;
    const end = [...r.steps].reverse().find((s) => s.kind === 'url' || s.kind === 'goto')?.url ?? r.startUrl;
    if (!end || pathOf(end) === pathOf(url)) {
      if (r.elsewhere) set({ recorder: { ...r, elsewhere: undefined } });
      return;
    }
    set({ recorder: { ...r, elsewhere: end } });
  }

  /** Carry on writing the kept test from where the app is now, though its steps end elsewhere. */
  keepKeptSteps(): void {
    const r = get().recorder;
    if (r.elsewhere) set({ recorder: { ...r, elsewhere: undefined } });
  }

  private appSwitched(changed = true): void {
    // The same app, opened again by a studio that restarted: what this page had of it stays.
    if (!changed) {
      // Opened again (a studio that restarted): its first page is checked against the kept steps.
      this.pageSeen = false;
      void this.refreshStatus();
      void this.refreshChanges();
      void sessions.refreshList();
      return;
    }
    // Requests made for the last app: the running one stops, the waiting ones aren't sent.
    this.appEpoch++;
    this.requests.stop();
    // The last app's test stays kept for it (keepRecorder); this app's own comes back.
    this.pageSeen = false;
    set({ selection: null, pins: [], hover: null, previewTargets: [], inspect: null, recorder: initialRecorder, changes: [], replay: null });
    if (get().mode === 'record') this.setMode('use');
    this.restoreRecorder(useApps.getState().active);
    void this.refreshStatus();
    void this.refreshChanges().then(() => this.announceWaiting());
    void sessions.refreshList();
  }

  /** Previews left from before (the studio was restarted, or this app was open earlier) are still on disk: say so. */
  private announceWaiting(): void {
    const n = get().changes.filter((c) => c.status === 'preview').length;
    if (n) this.notify(n === 1 ? 'A change from before is still a preview in your code. Keep it or undo it.' : `${n} changes from before are still previews in your code. Keep or undo them.`, 'info');
  }

  async refreshStatus(): Promise<StatusResponse | null> {
    try {
      const status = await api.get<StatusResponse>('/status');
      set({ status, statusError: null });
      return status;
    } catch (err) {
      set({ statusError: err instanceof Error ? err.message : String(err) });
      setTimeout(() => void this.refreshStatus(), 2000);
      return null;
    }
  }

  async refreshChanges(): Promise<void> {
    // Several at once (this tab's own change, and the event every tab gets for it): the last asked is the one shown.
    const asked = ++this.changesAsked;
    try {
      const { changes } = await api.get<{ changes: Change[] }>('/changes');
      if (asked === this.changesAsked) set({ changes });
    } catch {
      /* keep what we have */
    }
  }

  async refreshSummary(): Promise<void> {
    try {
      set({ summary: await api.get<MetricsSummary>('/metrics/summary') });
    } catch {
      /* optional */
    }
  }

  /** What the person points at, for AI apps connected over MCP (they ask the studio, not the page). */
  private pushContext = (() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const s = get();
        const ref = (el: ElementInfo, role: string): RefInfo => ({ role, src: el.src, name: el.name, label: el.label, text: el.text, tag: el.tag, hint: el.hint, frames: el.frames });
        const body = { pageUrl: s.app.url || null, selection: s.selection ? [ref(s.selection, 'selection')] : [], pins: s.pins.map((p) => ref(p, 'pin')) };
        const key = JSON.stringify(body);
        if (key === last) return;
        last = key;
        void api.put('/context', body).catch(() => undefined);
      }, 400);
    };
  })();
}

/** A check on a field reads its value, and on a list the option chosen. */
/** Where this tab keeps what Write test has so far (sessionStorage: this tab only, gone when it closes). */
const RECORDER_KEY = 'saywright.recorder';
/** Where the test being written for an app is kept, in this tab. */
const recorderKey = (app: string) => `${RECORDER_KEY}:${app}`;

/** A page by its path and #route, as steps that wait for one compare them. */
function pathOf(u: string): string {
  try {
    const x = new URL(u);
    return x.hash.startsWith('#/') ? x.hash.split('?')[0] : x.pathname;
  } catch {
    return u;
  }
}

/** An element as a request names it to the studio's server. */
function refOf(el: ElementInfo, role: string): RefInfo {
  return { role, src: el.src, name: el.name, label: el.label, text: el.text, tag: el.tag, hint: el.hint, frames: el.frames, ...(el.same ? { same: el.same } : {}) };
}

/** Roles that are selected or not (aria-selected): a tab, an option of a listbox, a row or cell of a grid, a tree item. */
const SELECTABLE = new Set(['tab', 'option', 'row', 'gridcell', 'treeitem', 'columnheader', 'rowheader']);

/** Whether an element can be disabled, as Playwright's toBeDisabled reads it: a native control, or an ARIA one. */
function canDisable(el: ElementInfo): boolean {
  if (/^(?:button|input|select|textarea|fieldset|option|optgroup)$/.test(el.tag)) return true;
  return /^(?:button|checkbox|radio|switch|textbox|searchbox|combobox|listbox|menuitem|menuitemcheckbox|menuitemradio|option|slider|spinbutton|tab|treeitem|gridcell)$/.test(el.role ?? '');
}

function fieldOf(el: { tag: string }): Pick<Expectation, 'field'> {
  return el.tag === 'input' || el.tag === 'textarea' ? { field: 'value' } : el.tag === 'select' ? { field: 'select' } : {};
}

/** A session's steps a test can play, up to a moment. */
function stepsOf(a: SessionAnalysis, until = Infinity): RecordedStep[] {
  return a.steps
    .filter((s) => s.t <= until && s.kind !== 'navigate' && s.locator)
    .map((s) => ({
      kind: s.kind === 'fill' ? 'fill' : s.kind === 'press' ? 'press' : 'click',
      locator: s.locator,
      value: s.value,
      checked: s.checked,
      key: s.key,
      description: s.description,
      ...(s.secret ? { secret: s.secret } : {}),
      ...(s.select ? { select: s.select } : {}),
      ...(s.byValue && s.values ? { values: s.values, byValue: true } : {}),
    }));
}

export const controller = new Controller();
if (import.meta.env.DEV) Object.assign(window, { __saywright: controller, __saywrightStore: { get, set }, __saywrightSettings: useSettings });
import.meta.hot?.dispose(() => controller.dispose());
