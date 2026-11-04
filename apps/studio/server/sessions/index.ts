/**
 * Test sessions, end to end: recording (app events, narration, screenshots,
 * video), live transcription, and after Stop: analysis, scores and the report.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionBatch, SessionEvent, SessionEventBody } from '@saywright/vite/protocol';
import type { NarrationState, ReplayOutcome, ReportDecisions, ScoreSummary, SessionDetail, SessionLang, SessionLive, SessionMeta, SessionReport, SessionScores, TranscriptSegment } from '../../shared/session.ts';
import { HttpError } from '../http.ts';
import type { Project } from '../project.ts';
import { breathe } from '../slices.ts';
import { toFloat, type SpeechService } from '../speech/service.ts';
import type { SpeechLang } from '../speech/catalog.ts';
import { analyzeAsync, withFindings } from './analyze.ts';
import { localReport, reportLang, type ReportWriter } from './report.ts';
import { SourceMapper } from './sourcemap.ts';
import { SessionStore, videoParts, type StoredEvent } from './store.ts';
import { verify } from './verify.ts';
import { finishWebm } from './webm.ts';

interface SessionsDeps {
  project: Project;
  speech: SpeechService;
  emit: (event: string, data: SessionLive | Record<string, unknown>) => void;
  /** Writes the AI report; null when Claude isn't configured. */
  writer: () => ReportWriter | null;
}

/** Narration mode for the recogniser: a language, or both. */
function speechModeFor(lang: SessionLang): SpeechLang | 'auto' {
  return lang === 'en' ? 'en' : lang === 'ar' ? 'ar' : 'auto';
}

/** The latest problem of a recording goes out at most this often: it only feeds a "last issue" label. */
const ISSUE_EVERY_MS = 1000;
/** An earlier report's analysis small enough to read just for its scores (reports since keep them in session.json). */
const SMALL_ANALYSIS = 2 * 1024 * 1024;

const summaryOf = (s: SessionScores): ScoreSummary => ({ overall: s.overall, stability: s.stability.score, usability: s.usability.score, performance: s.performance.score, accessibility: s.accessibility.score });
/** Scores for comparing with: the numbers alone (each area's notes stay with its own report). */
const scoresFrom = (s: ScoreSummary): SessionScores => ({
  overall: s.overall,
  stability: { score: s.stability, notes: [] },
  usability: { score: s.usability, notes: [] },
  performance: { score: s.performance, notes: [] },
  accessibility: { score: s.accessibility, notes: [] },
});


/** How long a recording found unfinished at startup waits for its page to come back (it retries every few seconds). */
const RESUME_MS = 60_000;
export class Sessions {
  readonly store: SessionStore;
  private segmentNo = new Map<string, number>();
  private countTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processing = new Set<string>();
  /** Narration waiting for the speech engine to start (it loads the model on first use). */
  private live = new Map<string, Promise<boolean>>();
  /** What the recording page shows about it: loading the model, transcribing as you speak, or not available. */
  private narration = new Map<string, NarrationState>();
  /** Reports being translated into the other language, after they were written. */
  private translating = new Set<string>();
  /** Replays waiting to be compared with the session they replayed: replay id → that session, and how the replay went. */
  private replays = new Map<string, { original: string; outcome: ReplayOutcome }>();
  /** Sessions being compared with a replay right now. */
  private verifying = new Set<string>();
  /** What went wrong lately in each session (errors, failed requests, clicks that did nothing), for Autopilot. */
  private notable = new Map<string, { t: number; text: string }[]>();
  /** Each recording's key: an app's page writes to a session, and follows it, only with the key it was given. */
  private keys = new Map<string, string>();
  /** Recordings found unfinished when the studio started: each finishes unless its page comes back in time. */
  private recovering = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per recording: when its last problem went out, and the newest one waiting to (see ISSUE_EVERY_MS). */
  private issueFrames = new Map<string, { at: number; waiting: SessionLive | null; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(private deps: SessionsDeps) {
    this.store = new SessionStore(deps.project);
    // Left by a studio that stopped: a recording may go on (its page keeps what it records meanwhile); one that was
    // being processed is processed now.
    for (const m of this.store.list()) {
      if (m.status === 'recording') this.recover(m);
      else if (m.status === 'processing') void this.finish(m.id, 'Recovered after a restart');
    }
  }

  private emit(live: SessionLive): void {
    this.deps.emit('session', live);
  }

  /**
   * A session the studio was recording when it stopped. The page recording it keeps what it records while the
   * studio is away, and sends it once the studio is back: for a while its key is taken again and the recording
   * goes on. If nothing comes, it is finished with what it has, and its report says where it ended.
   */
  private recover(m: SessionMeta): void {
    const key = this.store.savedKey(m.id);
    if (!key) return void this.finish(m.id, 'Recovered after a restart');
    this.keys.set(m.id, key);
    this.store.update(m.id, { restarts: [...(m.restarts ?? []), { at: Date.now(), resumed: false }] });
    const timer = setTimeout(() => {
      this.recovering.delete(m.id);
      if (this.store.meta(m.id).status === 'recording') void this.finish(m.id, 'Recovered after a restart');
    }, RESUME_MS);
    timer.unref?.();
    this.recovering.set(m.id, timer);
  }

  /** The page recording a session sent something: after a restart, that recording goes on. */
  resumed(id: string): void {
    const timer = this.recovering.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.recovering.delete(id);
    const restarts = this.store.meta(id).restarts ?? [];
    this.store.update(id, { restarts: restarts.map((r, i) => (i === restarts.length - 1 ? { ...r, resumed: true } : r)) });
    this.emit({ kind: 'status', id, status: 'recording' });
  }

  active(): SessionMeta | null {
    return this.store.active();
  }

  start(input: { name?: string; appUrl: string; source: SessionMeta['source']; replayOf?: string; lang: SessionLang; replace?: boolean }): SessionMeta {
    const running = this.store.active();
    if (running) {
      // One that has gone quiet was left behind (its tab closed or crashed): finish it and carry on.
      const idle = this.store.idleFor(running.id);
      if (input.replace || idle > 45_000) this.stop(running.id, input.replace ? undefined : Date.now() - idle);
      else throw new HttpError(409, `Another session is recording (${running.name}, from ${running.source === 'app' ? 'the app’s own tab' : 'the studio'}).`, 'busy');
    }
    const meta = this.store.create(input);
    this.segmentNo.set(meta.id, 0);
    const key = randomBytes(16).toString('hex');
    this.keys.set(meta.id, key);
    this.store.saveKey(meta.id, key);
    this.emit({ kind: 'status', id: meta.id, status: 'recording' });
    // Start the recogniser now so the first sentence isn't waiting on a model load (a replay and Autopilot have no narration).
    if (meta.source !== 'replay' && meta.source !== 'autopilot') this.live.set(meta.id, this.openLive(meta));
    return meta;
  }

  private async openLive(meta: SessionMeta): Promise<boolean> {
    const mode = speechModeFor(meta.lang);
    const done = (ok: boolean) => {
      this.narration.set(meta.id, ok ? 'live' : 'off');
      this.countsSoon(meta.id);
      return ok;
    };
    if (!this.deps.speech.canNarrate(mode)) return done(false);
    this.narration.set(meta.id, 'loading');
    try {
      await this.deps.speech.openStream(meta.id, mode, (seg) => this.onSegment(meta.id, seg, mode));
      return done(true);
    } catch (err) {
      console.warn('[saywright] live transcription unavailable:', err instanceof Error ? err.message : err);
      return done(false);
    }
  }

  private onSegment(id: string, seg: { start: number; end: number; text: string; ms: number; model: string }, mode: SpeechLang | 'auto'): void {
    const text = seg.text.trim();
    if (!text || /^[\s.,!?؟،-]*$/.test(text)) return;
    const n = (this.segmentNo.get(id) ?? 0) + 1;
    this.segmentNo.set(id, n);
    const segment: TranscriptSegment = {
      id: n,
      start: Math.round(this.store.audioTime(id, seg.start)),
      end: Math.round(this.store.audioTime(id, seg.end)),
      text,
      lang: /[\u0600-\u06FF]/.test(text) ? 'ar' : /[a-z]/i.test(text) ? 'en' : mode === 'auto' ? 'ar' : mode,
      model: seg.model,
      ms: seg.ms,
      audioAt: +(seg.start / 16000).toFixed(2),
    };
    try {
      this.store.addSegment(id, segment);
    } catch {
      return; // deleted meanwhile
    }
    this.emit({ kind: 'speech', id, segment });
    this.countsSoon(id);
  }

  private countsSoon(id: string): void {
    if (this.countTimers.has(id)) return;
    this.countTimers.set(
      id,
      setTimeout(() => {
        this.countTimers.delete(id);
        try {
          const m = this.store.meta(id);
          this.emit({ kind: 'counts', id, counts: m.counts, audioSeconds: m.audioSeconds, narration: this.narration.get(id) });
        } catch {
          /* gone */
        }
      }, 400),
    );
  }

  events(id: string, batch: SessionBatch): number {
    const fresh = this.store.appendEvents(id, batch);
    if (fresh.length) {
      this.countsSoon(id);
      for (const e of fresh) {
        if (e.type === 'error' || (e.type === 'net' && !e.ok && e.error !== 'aborted') || e.type === 'rage' || e.type === 'dead') {
          const text = e.type === 'error' ? e.message : e.type === 'net' ? `${e.method} ${e.url} → ${e.status || e.error}` : e.type === 'rage' ? 'Rage clicks' : 'Click did nothing';
          this.issueSoon({ kind: 'issue', id, t: e.t, text });
          this.remember(id, e.t, e.type === 'error' ? `Error: ${text}` : e.type === 'net' ? `Failed request: ${text}` : e.type === 'dead' ? `A click on ${e.el.label || e.el.name} did nothing` : text);
        } else if (e.type === 'console' && e.level === 'error') this.remember(id, e.t, `Console error: ${e.text}`);
      }
    }
    return fresh.length;
  }

  /** The latest problem, now if none went out in the last second, else when the second is up (an error loop is one label, not a flood). */
  private issueSoon(live: SessionLive & { kind: 'issue' }): void {
    let f = this.issueFrames.get(live.id);
    if (!f) this.issueFrames.set(live.id, (f = { at: 0, waiting: null, timer: null }));
    const wait = f.at + ISSUE_EVERY_MS - Date.now();
    if (!f.timer && wait <= 0) {
      f.at = Date.now();
      this.emit(live);
      return;
    }
    f.waiting = live;
    const frame = f;
    frame.timer ??= setTimeout(() => {
      frame.timer = null;
      frame.at = Date.now();
      if (frame.waiting) this.emit(frame.waiting);
      frame.waiting = null;
    }, Math.max(0, wait));
  }

  private remember(id: string, t: number, text: string): void {
    let list = this.notable.get(id);
    if (!list) this.notable.set(id, (list = []));
    list.push({ t, text: text.slice(0, 240) });
    if (list.length > 40) list.shift();
  }

  /** What went wrong in a session after `t` (Date.now() time), oldest first. */
  notableSince(id: string, t: number): string[] {
    return (this.notable.get(id) ?? []).filter((n) => n.t > t).map((n) => n.text);
  }

  /** Events the studio itself records (pointing, commands, marks). */
  studioEvent(id: string, body: SessionEventBody & { t: number }): void {
    // Unique within the studio's page: wall-clock based, so restarts never reuse one.
    const seq = Date.now() * 100 + Math.floor(Math.random() * 100);
    this.events(id, { page: 'studio', events: [{ ...body, seq } as SessionEvent] });
  }

  /**
   * Narration audio from the page. It is on disk when this returns; the
   * recogniser gets it in order once its model has loaded, without holding up
   * the upload (a page that is waiting on the studio can lose audio on reload).
   */
  audio(id: string, t: number, pcm: Buffer): void {
    const { samples } = this.store.appendAudio(id, t, pcm);
    if (!samples) return;
    this.countsSoon(id);
    const live = this.live.get(id);
    if (!live) return;
    const floats = toFloat(pcm);
    void live.then((ready) => ready && this.deps.speech.push(id, floats));
  }

  /**
   * Stop recording and write the report. Returns at once; progress arrives as
   * status events. `endedAt`: when Stop was pressed (the page sends what it
   * captured until then before it asks to stop).
   */
  /** The key an app's page needs to write to this session (given to whoever started it). */
  key(id: string): string | null {
    return this.keys.get(id) ?? null;
  }

  stop(id: string, endedAt?: unknown): SessionMeta {
    const meta = this.store.meta(id);
    if (meta.status !== 'recording') return meta;
    const recovering = this.recovering.get(id);
    if (recovering) clearTimeout(recovering);
    this.recovering.delete(id);
    const now = Date.now();
    const end = typeof endedAt === 'number' && endedAt >= meta.startedAt && endedAt <= now ? endedAt : now;
    const updated = this.store.update(id, { status: 'processing', stage: 'Finishing the transcript', endedAt: end });
    this.emit({ kind: 'status', id, status: 'processing', stage: updated.stage });
    this.notable.delete(id);
    const frame = this.issueFrames.get(id);
    if (frame?.timer) clearTimeout(frame.timer);
    this.issueFrames.delete(id);
    void this.finish(id);
    return updated;
  }

  private stage(id: string, stage: string): void {
    this.store.update(id, { stage });
    this.emit({ kind: 'status', id, status: 'processing', stage });
  }

  private async finish(id: string, note?: string): Promise<void> {
    if (this.processing.has(id)) return;
    this.processing.add(id);
    // Nothing more is written to it: a studio that restarts now takes nothing for it.
    this.store.dropKey(id);
    try {
      const meta = this.store.meta(id);
      if (meta.status === 'recording' || !meta.endedAt) this.store.update(id, { status: 'processing', endedAt: meta.endedAt ?? Date.now() });
      // Live transcription: wait for the model if it is still loading (a short session), then for the last sentence.
      const live = this.live.get(id);
      this.live.delete(id);
      this.narration.delete(id);
      if (live) {
        if (await live) await this.deps.speech.close(id);
      } else if (note && this.store.audioChunks(id).length && !this.store.transcript(id).length && this.deps.speech.canNarrate(speechModeFor(meta.lang))) {
        // Recovered after a restart: transcribe what was recorded. The report is still written if this fails.
        await this.transcribeAll(id).catch((err) => console.warn('[saywright] transcribing the recovered session failed:', err instanceof Error ? err.message : err));
      }
      await this.finishVideo(id);
      // The app's last batch of events can arrive just after Stop: give it a moment before reading them.
      const stopped = this.store.stoppedAt(id);
      if (stopped) await new Promise((r) => setTimeout(r, Math.max(0, stopped + 1000 - Date.now())));
      await this.process(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[saywright] session processing failed:', err);
      try {
        this.store.update(id, { status: 'failed', error: message, stage: undefined });
        this.emit({ kind: 'status', id, status: 'failed', error: message });
      } catch {
        /* deleted */
      }
      // A replay that couldn't be analysed: the session it checks isn't being compared any more.
      this.compareReplay(id);
    } finally {
      this.processing.delete(id);
      this.store.release(id);
    }
  }

  /** Recordings are written live, without a length: write it in, so the report's player can scrub. */
  private async finishVideo(id: string): Promise<void> {
    const meta = this.store.meta(id);
    const parts = videoParts(meta);
    if (!parts.length) return;
    this.stage(id, 'Finishing the screen recording');
    let changed = false;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].ms !== undefined) continue;
      const file = this.store.videoFile(id, i + 1);
      const ms = file ? await finishWebm(file) : null;
      if (ms !== null) {
        parts[i] = { ...parts[i], ms };
        changed = true;
      }
    }
    if (changed && meta.video) this.store.update(id, { video: { ...meta.video, parts } });
  }

  /**
   * Point every element and error at the project's own source: apps without
   * the Vite plugin report bundle positions, which source maps lead back from.
   * Each distinct position and stack is traced once, however often it recurs.
   */
  private async traceSources(events: StoredEvent[]): Promise<StoredEvent[]> {
    const mapper = new SourceMapper(this.deps.project);
    const plain = /^[\w@./-]+\.[jt]sx?:\d+:\d+$/;
    const isPlain = (src: string) => plain.test(src) && !src.startsWith('/') && !src.includes('/.next/');
    const elOf = (e: StoredEvent) => ('el' in e && e.el && typeof e.el === 'object' ? e.el : null);
    const srcs = new Set<string>();
    const stacks = new Set<string>();
    for (const e of events) {
      const src = elOf(e)?.src;
      if (src && !isPlain(src)) srcs.add(src);
      if (e.type === 'error' || e.type === 'console' || e.type === 'net') {
        if (e.stack) stacks.add(e.stack);
        if (e.type === 'error' && e.source && !isPlain(e.source)) srcs.add(e.source);
      }
    }
    const mapped = new Map(await Promise.all([...srcs].map(async (src) => [src, await mapper.map(src).catch(() => null)] as const)));
    const traced = new Map(await Promise.all([...stacks].map(async (stack) => [stack, await mapper.mapStack(stack).catch(() => stack)] as const)));
    let n = 0;
    for (const e of events) {
      if (++n % 1000 === 0) await breathe();
      const el = elOf(e);
      if (el?.src && !isPlain(el.src)) el.src = mapped.get(el.src) ?? null;
      if (e.type === 'error' || e.type === 'console' || e.type === 'net') {
        if (e.stack) e.stack = traced.get(e.stack) ?? e.stack;
        if (e.type === 'error' && e.source && !isPlain(e.source)) e.source = mapped.get(e.source) ?? e.source;
      }
    }
    return events;
  }

  /** Analysis, then the report (Claude when configured, otherwise written locally). A replay is only analysed, then compared. */
  async process(id: string, opts: { ai?: boolean } = {}): Promise<void> {
    this.stage(id, 'Finding issues');
    const meta = this.store.meta(id);
    const events = await this.traceSources(await this.store.eventsForAnalysis(id));
    const analysis = await analyzeAsync(meta, events, this.store.transcript(id), this.store.shots(id));
    this.store.saveAnalysis(id, analysis);
    if (meta.source === 'replay') {
      const done = this.store.update(id, { status: 'ready', stage: undefined, error: undefined });
      this.emit({ kind: 'status', id, status: done.status });
      this.compareReplay(id);
      return;
    }
    const writer = opts.ai === false ? null : this.deps.writer();
    // In the language spoken; the other language follows.
    const lang = reportLang(meta, analysis);
    let report: SessionReport;
    let note: { en: string; ar: string } | undefined;
    if (writer) {
      this.stage(id, 'Writing the report');
      try {
        report = await writer.write({ meta, analysis, project: this.deps.project, shotPath: (name) => this.store.shotFile(id, name), previous: this.previous(meta), dismissed: this.store.decisions(id).skipped });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.warn('[saywright] AI report failed, writing it locally:', why);
        note = { en: `The AI couldn’t write this report (${why}), so it was written on this computer.`, ar: `تعذّر على الذكاء الاصطناعي كتابة هذا التقرير (${why})، لذا كُتب على هذا الجهاز.` };
        report = localReport(meta, analysis, note, lang);
      }
    } else {
      report = localReport(meta, analysis, undefined, lang);
    }
    this.store.saveReport(id, report);
    if (report.source === 'local') this.store.saveTranslation(id, localReport(meta, analysis, note, lang === 'ar' ? 'en' : 'ar'));
    // A high finding the report found (a wrong total) holds the overall score down, as one the recording showed does.
    const scores = withFindings(analysis.scores, report.findings);
    if (scores !== analysis.scores) this.store.saveAnalysis(id, { ...analysis, scores });
    const done = this.store.update(id, {
      status: 'ready',
      stage: undefined,
      error: undefined,
      report: { source: report.source, model: report.model, at: report.at, overall: scores.overall, title: report.title, scores: summaryOf(scores), findings: report.findings.length },
    });
    this.emit({ kind: 'status', id, status: done.status });
    if (report.source !== 'local') void this.translate(id);
  }

  /**
   * The report in the other language, by the AI, once the report itself is
   * written (it can be read meanwhile). Ids, evidence and locations stay the
   * same; only the words change.
   */
  async translate(id: string): Promise<void> {
    const report = this.store.report(id);
    const writer = this.deps.writer();
    if (!report || !writer?.translate || this.translating.has(id)) return;
    this.translating.add(id);
    this.emit({ kind: 'report', id });
    try {
      const translated = await writer.translate(report, report.lang === 'ar' ? 'en' : 'ar');
      // Unless the report was rewritten meanwhile.
      if (this.store.report(id)?.at === report.at) this.store.saveTranslation(id, translated);
    } catch (err) {
      console.warn('[saywright] translating the report failed:', err instanceof Error ? err.message : err);
    } finally {
      this.translating.delete(id);
      this.emit({ kind: 'report', id });
    }
  }

  /** Set findings aside (or bring them back). */
  decide(id: string, d: ReportDecisions): ReportDecisions {
    this.store.meta(id);
    const saved = this.store.saveDecisions(id, d);
    this.emit({ kind: 'report', id });
    return saved;
  }

  /** The tester corrected what a sentence says; rewriting the report uses it. */
  correct(id: string, segId: number, text: string): TranscriptSegment {
    const meta = this.store.meta(id);
    if (meta.status === 'recording') throw new HttpError(409, 'Stop the session first');
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) throw new HttpError(400, 'A sentence can’t be empty');
    const seg = this.store.correctSegment(id, segId, clean.slice(0, 1000));
    this.emit({ kind: 'report', id });
    return seg;
  }

  /** Re-run transcription over the whole recording (after installing a model, or switching language). */
  async retranscribe(id: string, lang?: SessionLang): Promise<void> {
    const meta = this.store.meta(id);
    if (meta.status === 'recording') throw new HttpError(409, 'Stop the session first');
    if (this.processing.has(id)) throw new HttpError(409, 'Still processing');
    this.processing.add(id);
    try {
      if (lang) this.store.update(id, { lang });
      this.store.update(id, { status: 'processing', stage: 'Transcribing the narration' });
      this.emit({ kind: 'status', id, status: 'processing', stage: 'Transcribing the narration' });
      await this.transcribeAll(id);
      await this.process(id);
    } finally {
      this.processing.delete(id);
    }
  }

  private async transcribeAll(id: string): Promise<void> {
    const meta = this.store.meta(id);
    const mode = speechModeFor(meta.lang);
    if (!this.deps.speech.canNarrate(mode)) throw new HttpError(409, `No ${mode === 'en' ? 'English' : 'Arabic'} speech model is installed. Install one in Settings → Voice.`);
    this.store.resetTranscript(id);
    this.segmentNo.set(id, 0);
    const sid = `${id}:all`;
    await this.deps.speech.openStream(sid, mode, (seg) => this.onSegment(id, seg, mode));
    const chunks = this.store.audioChunks(id);
    const total = chunks.length ? chunks[chunks.length - 1].at + chunks[chunks.length - 1].samples : 0;
    for (let at = 0; at < total; at += 16000 * 10) {
      this.deps.speech.push(sid, toFloat(this.store.readAudio(id, at, Math.min(total, at + 16000 * 10))));
      // Let the worker breathe between pushes.
      await new Promise((r) => setImmediate(r));
    }
    await this.deps.speech.close(sid);
  }

  /**
   * The studio finished replaying `original`'s steps as session `replay`: compare the two once the replay is
   * analysed (now, if it already is).
   */
  verify(original: string, replay: string, outcome: ReplayOutcome): void {
    const meta = this.store.meta(replay);
    if (meta.replayOf !== original) throw new HttpError(400, 'That replay is of another session');
    this.replays.set(replay, { original, outcome });
    this.verifying.add(original);
    this.emit({ kind: 'report', id: original });
    if (meta.status === 'ready') this.compareReplay(replay);
  }

  private compareReplay(replay: string): void {
    const pending = this.replays.get(replay);
    if (!pending) return;
    this.replays.delete(replay);
    const { original, outcome } = pending;
    try {
      const before = this.store.analysis(original);
      const after = this.store.analysis(replay);
      if (before && after) {
        const older = this.store.verification(original)?.replay;
        this.store.saveVerification(original, verify(before, this.store.report(original), after, outcome, replay));
        // Only the latest replay is kept.
        if (older && older !== replay) {
          try {
            this.store.remove(older);
          } catch {
            /* already gone */
          }
        }
      }
    } catch (err) {
      console.warn('[saywright] comparing the replay failed:', err instanceof Error ? err.message : err);
    } finally {
      this.verifying.delete(original);
      this.emit({ kind: 'report', id: original });
    }
  }

  previous(meta: SessionMeta): SessionDetail['previous'] {
    const older = this.store.list().find((m) => m.startedAt < meta.startedAt && m.status === 'ready' && m.id !== meta.id && m.source !== 'replay');
    if (!older) return null;
    return { id: older.id, name: older.name, startedAt: older.startedAt, scores: this.scoresOf(older) };
  }

  /** A session's scores to compare with: kept with it since reports store them, else read from a small analysis. */
  private scoresOf(meta: SessionMeta): SessionScores | null {
    if (meta.report?.scores) return scoresFrom(meta.report.scores);
    try {
      if (fs.statSync(path.join(this.store.dir(meta.id), 'analysis.json')).size > SMALL_ANALYSIS) return null;
    } catch {
      return null;
    }
    const scores = this.store.analysis(meta.id)?.scores;
    return scores ? scoresFrom(summaryOf(scores)) : null;
  }

  detail(id: string): SessionDetail {
    const meta = this.store.meta(id);
    return {
      meta,
      analysis: this.store.analysis(id),
      report: this.store.report(id),
      translation: this.store.translation(id),
      translating: this.translating.has(id),
      decisions: this.store.decisions(id),
      previous: this.previous(meta),
      verification: this.store.verification(id),
      verifying: this.verifying.has(id),
    };
  }

  close(): void {
    for (const t of this.countTimers.values()) clearTimeout(t);
    this.countTimers.clear();
    for (const f of this.issueFrames.values()) if (f.timer) clearTimeout(f.timer);
    this.issueFrames.clear();
    // A recording still waiting for its page stays as it is on disk: the next studio waits for it in turn.
    for (const t of this.recovering.values()) clearTimeout(t);
    this.recovering.clear();
    this.store.close();
  }

  remove(id: string): void {
    const meta = this.store.meta(id);
    if (meta.status === 'recording') throw new HttpError(409, 'Stop the session first');
    this.store.remove(id);
    this.keys.delete(id);
    // Its replays go with it.
    for (const m of this.store.list()) if (m.replayOf === id && m.status !== 'recording') this.store.remove(m.id);
  }
}
