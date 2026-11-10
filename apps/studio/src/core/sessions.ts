/**
 * Test sessions from the studio: start and stop recording, stream narration
 * and the screen, add what only the studio knows (what you pointed at with
 * your hand, the commands you gave), and open reports.
 */
import { create } from 'zustand';
import { initialState, SessionClient, type ClientState, type NarrationLang } from '@saywright/vite/client';
import type { ElementInfo, LocatorInfo, SessionEventBody, SessionTarget } from '@saywright/vite/protocol';
import type { SpeechStatus } from '@shared/api';
import type { SessionDetail, SessionLang, SessionMeta } from '@shared/session';
import { api } from '@/lib/api';

export type { SpeechStatus };

export interface SessionPrefs {
  lang: NarrationLang;
  mic: boolean;
  screen: boolean;
  video: boolean;
  /** Seconds counted down before recording starts (0: at once). */
  countdown: number;
}

interface SessionsUi {
  live: ClientState;
  list: SessionMeta[];
  /** The report being viewed, and its data. */
  open: string | null;
  detail: SessionDetail | null;
  detailError: string | null;
  /** The language to read reports in; null: the language the session was spoken in. */
  reportLang: 'en' | 'ar' | null;
  setup: boolean;
  speech: SpeechStatus | null;
  prefs: SessionPrefs;
  /** A mark whose note is being typed: the moment it was made, and the words so far. */
  noting: { t: number; via: string; text: string } | null;
}

const PREFS_KEY = 'saywright.session.prefs';
const REPORT_LANG_KEY = 'saywright.report.lang';

function loadReportLang(): 'en' | 'ar' | null {
  try {
    const v = localStorage.getItem(REPORT_LANG_KEY);
    return v === 'en' || v === 'ar' ? v : null;
  } catch {
    return null;
  }
}

function loadPrefs(): SessionPrefs {
  const fallback: SessionPrefs = { lang: navigator.language?.startsWith('ar') ? 'ar' : 'auto', mic: true, screen: true, video: true, countdown: 3 };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return fallback;
  }
}

export const useSessions = create<SessionsUi>()(() => ({
  live: initialState,
  list: [],
  open: null,
  detail: null,
  detailError: null,
  reportLang: loadReportLang(),
  setup: false,
  speech: null,
  prefs: loadPrefs(),
  noting: null,
}));

const setS = useSessions.setState;
const getS = useSessions.getState;

function toTarget(el: ElementInfo): SessionTarget {
  return {
    src: el.src,
    name: el.name,
    tag: el.tag,
    role: el.role,
    label: el.label.replace(/^[^·]*·\s*/, '').slice(0, 60),
    text: el.text,
    rect: [Math.round(el.rect.x), Math.round(el.rect.y), Math.round(el.rect.w), Math.round(el.rect.h)],
  };
}

interface SessionHost {
  /** The app's frame: the screen recording is cropped to it. */
  frame(): HTMLIFrameElement | null;
  /** Whether the app in the frame is connected (its events can be recorded). */
  appConnected(): boolean;
  appUrl(): string;
  /** Starting resolves once the app's recorder is on. */
  /** Whether the app said it is recording (always true for stopping). */
  /** `key`: what lets the app's page write to the session (the studio got it when the session started). */
  bridgeSession(on: boolean, id?: string, endpoint?: string, key?: string): Promise<boolean>;
  bridgeMark(note: string, via: string): void;
  /** Switch to Use mode while recording, so clicks reach the app. */
  enterUse(): () => void;
  /** Tell the person something that happened in the background, with what they can do about it. */
  notify(text: string, actions: { label: string; run: () => void; primary?: boolean }[]): void;
  /** How a test finds an element of the app (its Playwright locator), while it is there; null once it is gone. */
  locate(id: number): Promise<LocatorInfo | null>;
}

/** Pointed at for at least this long: recorded, and named the way a test would find it. */
const POINT_MS = 500;

interface Pointing {
  el: ElementInfo;
  since: number;
  via: 'hand' | 'mouse';
  timer: ReturnType<typeof setTimeout>;
  locator?: Promise<LocatorInfo | null>;
}

class StudioSessions {
  readonly client = new SessionClient();
  private host: SessionHost | null = null;
  private outbox: (SessionEventBody & { t: number })[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pointing: Pointing | null = null;
  /** Locators still being looked up for elements pointed at: their events wait for them (briefly) before being sent. */
  private lookups = new Set<Promise<void>>();
  private restoreMode: (() => void) | null = null;
  private seq = 0;
  /** The recording's key, which the app's page needs to write to it (see bridgeSession). */
  private key: string | undefined;
  /** Reports of sessions the bar has moved on from (a new one started), not opened yet: id → name. Each is announced once ready. */
  private awaiting = new Map<string, string>();
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.client.useExternalEvents();
    this.client.subscribe((live) => {
      const prev = getS().live;
      setS({ live });
      if (prev.status !== live.status && (live.status === 'ready' || live.status === 'failed')) void this.refreshList();
      this.syncPoll();
    });
  }

  /**
   * A report's progress arrives over the event stream; while one is written (this session's, or one still to be
   * announced), also ask now and then, so an update missed while the stream reconnected can't be lost.
   */
  private syncPoll(): void {
    if (getS().live.status === 'processing' || this.awaiting.size) this.poll ??= setInterval(() => void this.resync(), 4000);
    else if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  init(host: SessionHost): void {
    this.host = host;
    void this.refreshList();
    void this.refreshSpeech();
    // A report link (from the app's own tab) opens straight into the report.
    const m = /^\/report\/([\w-]+)/.exec(location.pathname);
    if (m) this.openReport(m[1]);
    // A session still recording (the studio was reloaded): follow it.
    void api.get<{ session: SessionMeta | null; key?: string }>('/sessions/active').then(({ session, key }) => {
      if (session && session.source === 'studio' && getS().live.status === 'idle') {
        this.key = key;
        this.client.attach(location.origin, session.id, session.startedAt);
        void this.host?.bridgeSession(true, session.id, location.origin, key);
        this.restoreMode = this.host?.enterUse() ?? null;
      }
    });
  }

  /** Events from the studio server's stream (the controller owns the connection). */
  serverEvent(name: string, data: unknown): void {
    if (name === 'speech') setS({ speech: data as SpeechStatus });
    else if (name === 'session') {
      const m = data as { kind: string; id: string; status?: string };
      this.client.handle(m);
      if (m.kind === 'status') {
        void this.refreshList();
        if (getS().open === m.id) void this.loadDetail(m.id);
        if (m.status === 'ready' || m.status === 'failed') this.announce(m.id, m.status);
      } else if (m.kind === 'report' && getS().open === m.id) void this.loadDetail(m.id);
    }
  }

  /**
   * Catch up with the server: after the event stream reconnects (updates sent
   * meanwhile were missed), and every few seconds while a report is written.
   */
  async resync(): Promise<void> {
    await this.refreshList();
    const live = getS().live;
    const meta = live.id ? getS().list.find((m) => m.id === live.id) : undefined;
    if (meta && live.status === 'processing' && meta.status !== 'processing') this.client.handle({ kind: 'status', id: meta.id, status: meta.status, stage: meta.stage, error: meta.error });
    for (const id of this.awaiting.keys()) {
      const m = getS().list.find((x) => x.id === id);
      if (!m || m.status === 'ready' || m.status === 'failed') this.announce(id, m?.status ?? 'failed');
    }
  }

  /** A report the bar no longer shows is ready (or couldn't be written): say so, without getting in the way of a recording. */
  private announce(id: string, status: string): void {
    const name = this.awaiting.get(id);
    if (name === undefined) return;
    this.awaiting.delete(id);
    this.syncPoll();
    if (getS().open === id) return;
    this.host?.notify(status === 'ready' ? `Report ready: ${name}` : `The report for “${name}” couldn’t be written`, [{ label: 'Open', run: () => this.openReport(id), primary: true }]);
  }

  setPrefs(patch: Partial<SessionPrefs>): void {
    const prefs = { ...getS().prefs, ...patch };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    setS({ prefs });
  }

  get recording(): boolean {
    const st = getS().live.status;
    return st === 'recording' || st === 'starting' || st === 'stopping';
  }

  async start(name?: string, replace = false): Promise<void> {
    if (!this.host || this.recording) return;
    const p = getS().prefs;
    setS({ setup: false });
    // The bar moves on to this session: the last one's report, unopened, is announced once ready (or once this one
    // has started, if it already is), whenever that happens.
    const last = getS().live;
    const done = last.status === 'ready' || last.status === 'failed';
    if (last.id && (last.status === 'processing' || done)) this.awaiting.set(last.id, getS().list.find((m) => m.id === last.id)?.name || 'the last session');
    this.syncPoll();
    try {
      const host = this.host;
      await this.client.start({
        endpoint: location.origin,
        name,
        lang: p.lang,
        appUrl: host.appUrl(),
        source: 'studio',
        mic: p.mic,
        screen: p.screen,
        video: p.video && p.screen,
        crop: host.frame(),
        replace,
        countdown: p.countdown,
        appReady: () => host.appConnected(),
        // The app's events from the first moment, not once the microphone is ready.
        onCreated: async (id, key) => {
          this.seq = 0;
          this.key = key;
          this.restoreMode = host.enterUse();
          await host.bridgeSession(true, id, location.origin, key);
        },
      });
    } catch {
      setS({ setup: true });
    }
    if (last.id && done) this.announce(last.id, last.status);
  }

  /** While counting down: record now. */
  startNow(): void {
    this.client.startNow();
  }

  /** While counting down: don't record after all. */
  cancelStart(): void {
    this.client.cancelStart();
  }

  async stop(): Promise<void> {
    if (!this.recording) return;
    if (getS().live.status === 'starting' && !getS().live.id) return this.cancelStart();
    // A note still being typed is kept with what it says so far.
    this.saveNote();
    this.flushPointing();
    await this.flush();
    void this.host?.bridgeSession(false);
    this.restoreMode?.();
    this.restoreMode = null;
    await this.client.stop();
  }

  /**
   * Mark this moment. Said aloud, the mark is whole. From the button or the key it can take a typed note (a tester
   * without a microphone says what they noticed this way): the moment and its screenshot are taken now, and the
   * words follow when the note is saved.
   */
  mark(note = '', via = 'key'): void {
    if (getS().live.status !== 'recording') return;
    if (note || via === 'voice') {
      this.host?.bridgeMark(note, via);
      // The app's recorder logs the mark; the studio adds a screenshot.
      this.client.moment('mark', true);
      return;
    }
    // Marked again while a note is open: that one is kept as it is.
    this.saveNote();
    this.client.moment('mark', true);
    setS({ noting: { t: Date.now(), via, text: '' } });
  }

  /** The words of the note being typed. */
  noteText(text: string): void {
    const noting = getS().noting;
    if (noting) setS({ noting: { ...noting, text: text.slice(0, 300) } });
  }

  /** Keep the mark being noted, at the moment it was made, with its words (`keepWords` false: without them). */
  saveNote(keepWords = true): void {
    const noting = getS().noting;
    if (!noting) return;
    setS({ noting: null });
    if (getS().live.status !== 'recording') return;
    this.queue({ type: 'mark', note: keepWords ? noting.text.trim() : '', via: noting.via, t: noting.t });
  }

  moment(reason: string): void {
    this.client.moment(reason);
  }

  /** The element under the mouse changed: what someone points at while talking is what they mean. */
  pointed(el: ElementInfo | null, via: 'hand' | 'mouse'): void {
    if (getS().live.status !== 'recording') return;
    const now = Date.now();
    if (this.pointing && el && this.pointing.el.id === el.id) return;
    this.flushPointing(now);
    if (!el) return;
    // Pointed at long enough to count: how a test finds it, asked while it is there (a click can remove it).
    const p: Pointing = { el, since: now, via, timer: setTimeout(() => (p.locator = this.locate(el)), POINT_MS) };
    this.pointing = p;
  }

  private locate(el: ElementInfo): Promise<LocatorInfo | null> {
    return this.host ? this.host.locate(el.id).catch(() => null) : Promise.resolve(null);
  }

  private flushPointing(now = Date.now()): void {
    const p = this.pointing;
    if (!p) return;
    this.pointing = null;
    clearTimeout(p.timer);
    const ms = now - p.since;
    if (ms < POINT_MS) return;
    // With its locator, a value said about it ("this should show $80.80") can be read again by a replay.
    const el = toTarget(p.el);
    const named = (p.locator ?? this.locate(p.el)).then((loc) => {
      if (loc) Object.assign(el, { locator: loc.code, description: loc.description, ...(loc.within ? { within: loc.within } : {}) });
    });
    this.lookups.add(named);
    void named.finally(() => this.lookups.delete(named));
    this.queue({ type: 'point', el, ms, via: p.via, t: p.since });
  }

  /** A command given by voice or typing during the session. */
  command(text: string, input: 'voice' | 'typed', result: string): void {
    if (getS().live.status !== 'recording') return;
    this.queue({ type: 'command', text: text.slice(0, 300), input, result: result.slice(0, 120), t: Date.now() });
  }

  private queue(ev: SessionEventBody & { t: number }): void {
    this.outbox.push(ev);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 1500);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.lookups.size) await Promise.race([Promise.all(this.lookups), new Promise((r) => setTimeout(r, 1000))]);
    const id = getS().live.id;
    if (!id || !this.outbox.length) return;
    const events = this.outbox.splice(0).map((e) => ({ ...e, seq: ++this.seq }));
    await api.post(`/sessions/${id}/studio-events`, { events }).catch(() => undefined);
  }

  async refreshList(): Promise<void> {
    const { sessions } = await api.get<{ sessions: SessionMeta[] }>('/sessions').catch(() => ({ sessions: [] as SessionMeta[] }));
    setS({ list: sessions });
  }

  async refreshSpeech(): Promise<void> {
    const speech = await api.get<SpeechStatus>('/speech/status').catch(() => null);
    if (speech) setS({ speech });
  }

  /** Load the speech models narration in this language will use, while the session is being set up. */
  warmSpeech(lang: SessionLang): void {
    void api.post('/speech/warm?mode=' + lang, {}).catch(() => undefined);
  }

  async installSpeech(id: string): Promise<void> {
    const speech = await api.post<SpeechStatus>('/speech/install', { id }).catch(() => null);
    if (speech) setS({ speech });
  }

  openReport(id: string): void {
    // Seen: the bar no longer needs to point at it.
    const live = getS().live;
    if (live.id === id && (live.status === 'ready' || live.status === 'failed')) this.client.reset();
    this.awaiting.delete(id);
    this.syncPoll();
    setS({ open: id, detail: null, detailError: null });
    if (location.pathname !== `/report/${id}`) history.pushState(null, '', `/report/${id}`);
    void this.loadDetail(id);
  }

  closeReport(): void {
    setS({ open: null, detail: null, detailError: null });
    if (location.pathname.startsWith('/report/')) history.pushState(null, '', '/');
  }

  async loadDetail(id: string): Promise<void> {
    try {
      const detail = await api.get<SessionDetail>(`/sessions/${id}`);
      if (getS().open === id) setS({ detail, detailError: null });
    } catch (err) {
      if (getS().open === id) setS({ detailError: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Read reports in this language from now on. */
  setReportLang(lang: 'en' | 'ar'): void {
    try {
      localStorage.setItem(REPORT_LANG_KEY, lang);
    } catch {
      /* private window */
    }
    setS({ reportLang: lang });
  }

  /** Set findings aside, or bring them back (by their title in the report's own language). */
  async setSkipped(id: string, skipped: string[]): Promise<void> {
    const d = getS().detail;
    if (d?.meta.id === id) setS({ detail: { ...d, decisions: { ...d.decisions, skipped } } });
    await api.put(`/sessions/${id}/decisions`, { skipped });
  }

  /** Correct what a sentence of the narration says. */
  async correctSentence(id: string, segId: number, text: string): Promise<void> {
    await api.put(`/sessions/${id}/transcript/${segId}`, { text });
    await this.loadDetail(id);
  }

  async retranslate(id: string): Promise<void> {
    await api.post(`/sessions/${id}/translate`, {});
    await this.loadDetail(id);
  }

  async regenerate(id: string, ai = true): Promise<void> {
    await api.post(`/sessions/${id}/report`, { ai });
    await this.loadDetail(id);
  }

  async retranscribe(id: string, lang?: NarrationLang): Promise<void> {
    await api.post(`/sessions/${id}/transcribe`, { lang });
    await this.loadDetail(id);
  }

  async rename(id: string, name: string): Promise<void> {
    await api.put(`/sessions/${id}`, { name });
    await this.refreshList();
    if (getS().open === id) await this.loadDetail(id);
  }

  async remove(id: string): Promise<void> {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (getS().open === id) this.closeReport();
    await this.refreshList();
  }

  /** The app reloaded and resumed a session we don't know about (or forgot ours): keep them in step. */
  bridgeSaid(id: string | null): void {
    const live = getS().live;
    if (live.status === 'recording' && live.id && id !== live.id) void this.host?.bridgeSession(true, live.id, location.origin, this.key);
  }
}

export const sessions = new StudioSessions();

window.addEventListener('popstate', () => {
  const m = /^\/report\/([\w-]+)/.exec(location.pathname);
  if (m) {
    if (getS().open !== m[1]) sessions.openReport(m[1]);
  } else if (getS().open) setS({ open: null, detail: null });
});

if (import.meta.env.DEV) Object.assign(window, { __saywrightSessions: sessions, __saywrightSessionsStore: useSessions });
