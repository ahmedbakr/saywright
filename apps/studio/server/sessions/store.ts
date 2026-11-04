/**
 * Test sessions on disk, in the app's .saywright/sessions/<id>/ folder:
 *
 *   session.json      what it is and how far processing got
 *   events.jsonl      every app and studio event, as received
 *   audio.pcm         narration, 16 kHz mono 16-bit, with audio.jsonl saying when each chunk started
 *   transcript.jsonl  what was said, sentence by sentence
 *   shots/            screenshots at key moments (+ shots.jsonl)
 *   video.webm        the screen, when shared
 *   analysis.json     what the studio found (issues, scores, timeline)
 *   report.json       the written report, in the language spoken
 *   report-ar.json    the same report in the other language (or report-en.json)
 *   decisions.json    findings the tester set aside
 *
 * Appends are synchronous and small (a batch a second), so a crash loses at
 * most the request in flight, which the bridge then resends.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { maskSecrets, redactUrl, scrubEvent, type SessionBatch, type SessionEvent } from '@saywright/vite/protocol';
import { EMPTY_COUNTS, NO_DECISIONS, type ReportDecisions, type SessionAnalysis, type SessionLang, type SessionMeta, type SessionReport, type SessionShot, type SessionVerification, type TranscriptSegment, type VideoPart } from '../../shared/session.ts';
import { writeFileAtomic } from '../fsx.ts';
import { HttpError } from '../http.ts';
import type { Project } from '../project.ts';

export const SAMPLE_RATE = 16000;

/** An event as stored: which page load it came from, plus the event. */
export type StoredEvent = SessionEvent & { page: string };

interface AudioChunk {
  /** Wall-clock time of the chunk's first sample. */
  t: number;
  /** Index of its first sample in audio.pcm. */
  at: number;
  samples: number;
}

interface Open {
  meta: SessionMeta;
  /** When the last events or audio arrived: a recording that went quiet was abandoned (a closed tab). */
  lastActivity: number;
  /** Sequence numbers already stored, per page load: resent batches are dropped. Read from disk only if a batch comes. */
  seen: Map<string, Set<number>> | null;
  audio: AudioChunk[];
  audioSamples: number;
  /** The last piece number written, per recording file. */
  videoPieces: Map<string, number>;
  /** When the recording stopped (see stoppedAt). */
  stoppedAt?: number;
  dirty: boolean;
}

const ID = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
/** How long after Stop the app's last events are still taken. */
const LATE_EVENTS_MS = 5000;
/** Events the analysis doesn't read (pointer trails, focus, window size, visibility): not loaded for it. */
const UNANALYSED = new Set(['trail', 'focus', 'resize', 'vis']);

/** The recordings of a session (older sessions kept one, without a list). */
export function videoParts(meta: SessionMeta): VideoPart[] {
  const v = meta.video;
  if (!v) return [];
  return v.parts ?? [{ startedAt: v.startedAt, bytes: v.bytes, file: 'video.webm' }];
}

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a line cut short by a crash */
    }
  }
  return out;
}

export class SessionStore {
  private open = new Map<string, Open>();
  private saveTimer: ReturnType<typeof setInterval>;

  constructor(private project: Project) {
    // Meta changes (counts) are batched to disk once a second.
    this.saveTimer = setInterval(() => this.saveDirty(), 1000);
    this.saveTimer.unref?.();
  }

  get root(): string {
    const dir = path.join(this.project.stateDir(), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Whether this app has a session with this id. */
  has(id: string): boolean {
    return ID.test(id) && fs.existsSync(path.join(this.root, id));
  }

  dir(id: string): string {
    if (!ID.test(id)) throw new HttpError(400, 'Bad session id');
    const dir = path.join(this.root, id);
    if (!fs.existsSync(dir)) throw new HttpError(404, 'No such session');
    return dir;
  }

  create(input: { name?: string; appUrl: string; source: SessionMeta['source']; lang: SessionLang; replayOf?: string }): SessionMeta {
    const t = Date.now();
    const id = `${stamp(t)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
    fs.mkdirSync(path.join(this.root, id, 'shots'), { recursive: true });
    const meta: SessionMeta = {
      id,
      name: input.name?.trim() || `Session ${new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      // As the events keep it: a reset link's token is not kept with the session (an older plugin sends it as it is).
      appUrl: redactUrl(input.appUrl),
      source: input.source,
      ...(input.replayOf ? { replayOf: input.replayOf } : {}),
      lang: input.lang,
      startedAt: t,
      endedAt: null,
      status: 'recording',
      git: null,
      counts: { ...EMPTY_COUNTS },
      audioSeconds: 0,
      video: null,
    };
    this.open.set(id, { meta, seen: new Map(), audio: [], audioSamples: 0, videoPieces: new Map(), dirty: true, lastActivity: Date.now() });
    this.saveMeta(meta);
    // The branch and commit join a moment later: git can take seconds in a big repository, and recording starts now.
    void this.gitInfo().then((git) => {
      const st = this.open.get(id);
      if (git && st) {
        st.meta.git = git;
        st.dirty = true;
      }
    });
    return meta;
  }

  private async gitInfo(): Promise<SessionMeta['git']> {
    if (!this.project.isGit) return null;
    const git = (...args: string[]) =>
      new Promise<string>((resolve, reject) => execFile('git', args, { cwd: this.project.root, timeout: 3000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out.trim()))));
    try {
      const [branch, commit, status] = await Promise.all([git('rev-parse', '--abbrev-ref', 'HEAD'), git('rev-parse', '--short', 'HEAD'), git('--no-optional-locks', 'status', '--porcelain')]);
      return { branch, commit, dirty: status.length > 0 };
    } catch {
      return null;
    }
  }

  /** The in-memory state of a session, rebuilt from disk after a restart. */
  private state(id: string): Open {
    const cached = this.open.get(id);
    if (cached) return cached;
    const dir = this.dir(id);
    const meta = this.meta(id);
    const audio = readJsonl<AudioChunk>(path.join(dir, 'audio.jsonl'));
    const last = audio[audio.length - 1];
    const st: Open = { meta, seen: null, audio, audioSamples: last ? last.at + last.samples : 0, videoPieces: new Map(), dirty: false, lastActivity: Date.now() };
    this.open.set(id, st);
    return st;
  }

  /** The events already stored, by page load (a long session's file is big: read only when a batch needs checking). */
  private seenOf(id: string, st: Open): Map<string, Set<number>> {
    if (st.seen) return st.seen;
    const seen = new Map<string, Set<number>>();
    for (const e of readJsonl<StoredEvent>(path.join(this.dir(id), 'events.jsonl'))) {
      let set = seen.get(e.page);
      if (!set) seen.set(e.page, (set = new Set()));
      set.add(e.seq);
    }
    st.seen = seen;
    return seen;
  }

  meta(id: string): SessionMeta {
    const st = this.open.get(id);
    if (st) return st.meta;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'session.json'), 'utf8')) as SessionMeta;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(404, 'Session data is missing');
    }
  }

  update(id: string, patch: Partial<SessionMeta>): SessionMeta {
    const st = this.state(id);
    if (patch.status && patch.status !== 'recording' && st.meta.status === 'recording') st.stoppedAt = Date.now();
    Object.assign(st.meta, patch);
    this.saveMeta(st.meta);
    return st.meta;
  }

  private saveMeta(meta: SessionMeta): void {
    writeFileAtomic(path.join(this.root, meta.id, 'session.json'), JSON.stringify(meta, null, 2), { sync: false });
    const st = this.open.get(meta.id);
    if (st) st.dirty = false;
  }

  /** Stop the timer and write what's pending (the studio is shutting down or restarting). */
  close(): void {
    clearInterval(this.saveTimer);
    this.saveDirty();
  }

  private saveDirty(): void {
    for (const st of this.open.values()) if (st.dirty) this.saveMeta(st.meta);
  }

  list(): SessionMeta[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root).filter((n) => ID.test(n));
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const n of names.sort().reverse()) {
      try {
        out.push(this.meta(n));
      } catch {
        /* half-created: skip */
      }
    }
    return out;
  }

  active(): SessionMeta | null {
    for (const st of this.open.values()) if (st.meta.status === 'recording') return st.meta;
    return null;
  }

  /** Milliseconds since the session last received anything. */
  idleFor(id: string): number {
    const st = this.open.get(id);
    return st ? Date.now() - st.lastActivity : Infinity;
  }

  /** Store a batch from the app (or the studio); returns how many events were new. */
  /**
   * When the session was stopped. The app's last events can still be on their way then (the app is told to
   * stop at the same moment): they are taken for a few seconds more.
   */
  stoppedAt(id: string): number | null {
    return this.open.get(id)?.stoppedAt ?? null;
  }

  appendEvents(id: string, batch: SessionBatch): StoredEvent[] {
    const st = this.state(id);
    const late = st.meta.status === 'processing' && st.stoppedAt !== undefined && Date.now() - st.stoppedAt < LATE_EVENTS_MS;
    if (st.meta.status !== 'recording' && !late) throw new HttpError(409, 'This session has ended');
    const page = String(batch.page ?? '').slice(0, 40) || 'unknown';
    const pages = this.seenOf(id, st);
    let seen = pages.get(page);
    if (!seen) pages.set(page, (seen = new Set()));
    const fresh: StoredEvent[] = [];
    for (const e of Array.isArray(batch.events) ? batch.events : []) {
      if (!e || typeof e !== 'object' || typeof e.seq !== 'number' || typeof e.t !== 'number' || typeof e.type !== 'string') continue;
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      // Scrubbed again as it is kept: an older plugin's events may hold a secret this version masks.
      fresh.push(scrubEvent({ ...e, page }));
    }
    st.lastActivity = Date.now();
    if (!fresh.length) return fresh;
    fs.appendFileSync(path.join(this.dir(id), 'events.jsonl'), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const c = st.meta.counts;
    for (const e of fresh) {
      c.events++;
      if (e.type === 'click') c.clicks++;
      else if (e.type === 'input' || e.type === 'change') c.inputs++;
      else if (e.type === 'page' || e.type === 'nav') c.pages++;
      else if (e.type === 'error' || (e.type === 'console' && e.level === 'error')) c.errors++;
      else if (e.type === 'net' && !e.ok && e.error !== 'aborted') c.failedRequests++;
      else if (e.type === 'rage' || e.type === 'dead') c.frustration++;
      else if (e.type === 'mark') c.marks++;
    }
    st.dirty = true;
    return fresh;
  }

  events(id: string): StoredEvent[] {
    return readJsonl<StoredEvent>(path.join(this.dir(id), 'events.jsonl')).sort((a, b) => a.t - b.t || a.seq - b.seq);
  }

  /**
   * The events the analysis reads, in time order: streamed from disk a piece at a time (a long session's file is tens
   * of megabytes), so the studio keeps answering meanwhile, without the kinds it doesn't read.
   */
  async eventsForAnalysis(id: string): Promise<StoredEvent[]> {
    const file = path.join(this.dir(id), 'events.jsonl');
    const out: StoredEvent[] = [];
    if (!fs.existsSync(file)) return out;
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let e: StoredEvent;
      try {
        e = JSON.parse(line) as StoredEvent;
      } catch {
        continue; // a line cut short by a crash
      }
      if (!UNANALYSED.has(e.type)) out.push(e);
    }
    return out.sort((a, b) => a.t - b.t || a.seq - b.seq);
  }

  /**
   * Store narration audio (16-bit PCM at 16 kHz) that started at wall-clock `t`.
   * Returns where it begins in the session's audio, in samples.
   */
  appendAudio(id: string, t: number, pcm: Buffer): { at: number; samples: number } {
    const st = this.state(id);
    if (st.meta.status !== 'recording') throw new HttpError(409, 'This session has ended');
    const samples = Math.floor(pcm.length / 2);
    if (!samples) return { at: st.audioSamples, samples: 0 };
    // The same chunk can arrive twice (a retry racing a beacon when the page closes).
    if (st.audio.some((c) => c.t === t && c.samples === samples)) return { at: st.audioSamples, samples: 0 };
    const dir = this.dir(id);
    fs.appendFileSync(path.join(dir, 'audio.pcm'), samples * 2 === pcm.length ? pcm : pcm.subarray(0, samples * 2));
    const chunk: AudioChunk = { t, at: st.audioSamples, samples };
    fs.appendFileSync(path.join(dir, 'audio.jsonl'), JSON.stringify(chunk) + '\n');
    st.audio.push(chunk);
    st.audioSamples += samples;
    st.lastActivity = Date.now();
    st.meta.audioSeconds = +(st.audioSamples / SAMPLE_RATE).toFixed(1);
    st.dirty = true;
    return { at: chunk.at, samples };
  }

  /** Wall-clock time of a sample in the session's audio. */
  audioTime(id: string, sample: number): number {
    const chunks = this.state(id).audio;
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chunks[mid].at <= sample) lo = mid;
      else hi = mid - 1;
    }
    const c = chunks[lo];
    return c ? c.t + ((sample - c.at) / SAMPLE_RATE) * 1000 : this.meta(id).startedAt;
  }

  /** The narration as a WAV file (for playback in the report). */
  audioWav(id: string): Buffer | null {
    const file = path.join(this.dir(id), 'audio.pcm');
    if (!fs.existsSync(file)) return null;
    const pcm = fs.readFileSync(file);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  /** Audio chunks with their start times, for re-transcribing a whole session. */
  audioChunks(id: string): AudioChunk[] {
    return this.state(id).audio.slice();
  }

  readAudio(id: string, fromSample: number, toSample: number): Int16Array {
    const file = path.join(this.dir(id), 'audio.pcm');
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.max(0, toSample - fromSample) * 2;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, fromSample * 2);
      return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(n / 2));
    } finally {
      fs.closeSync(fd);
    }
  }

  addSegment(id: string, seg: TranscriptSegment): void {
    fs.appendFileSync(path.join(this.dir(id), 'transcript.jsonl'), JSON.stringify(seg) + '\n');
    const st = this.state(id);
    st.meta.counts.speech++;
    st.dirty = true;
  }

  transcript(id: string): TranscriptSegment[] {
    // Re-transcription appends corrected segments; the last one per id wins.
    const byId = new Map<number, TranscriptSegment>();
    for (const s of readJsonl<TranscriptSegment>(path.join(this.dir(id), 'transcript.jsonl'))) byId.set(s.id, s);
    return Array.from(byId.values()).sort((a, b) => a.start - b.start);
  }

  /**
   * The tester corrected a sentence: the correction becomes its text, and what
   * the recogniser heard is kept. Appended like a re-transcription (the last
   * line per sentence wins), so nothing is rewritten in place.
   */
  correctSegment(id: string, segId: number, text: string): TranscriptSegment {
    const seg = this.transcript(id).find((s) => s.id === segId);
    if (!seg) throw new HttpError(404, 'No such sentence');
    const original = seg.original ?? seg.text;
    const fixed: TranscriptSegment = { ...seg, text, editedAt: Date.now() };
    if (text !== original) fixed.original = original;
    else delete fixed.original;
    fs.appendFileSync(path.join(this.dir(id), 'transcript.jsonl'), JSON.stringify(fixed) + '\n');
    // The report shows the analysis' copy of the transcript: keep it in step until the report is rewritten.
    const a = this.analysis(id);
    if (a) {
      a.transcript = a.transcript.map((s) => (s.id === segId ? { ...s, text: fixed.text, original: fixed.original, editedAt: fixed.editedAt } : s));
      for (const it of a.timeline) if (it.kind === 'speech' && it.t === seg.start) it.text = fixed.text;
      if (!fixed.original) for (const s of a.transcript) if (s.id === segId) delete s.original;
      this.saveAnalysis(id, a);
    }
    return fixed;
  }

  resetTranscript(id: string): void {
    fs.rmSync(path.join(this.dir(id), 'transcript.jsonl'), { force: true });
    this.state(id).meta.counts.speech = 0;
  }

  addShot(id: string, t: number, reason: string, jpeg: Buffer, size: { w: number; h: number }): SessionShot {
    const st = this.state(id);
    const name = `${Math.round(t)}-${reason.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'shot'}.jpg`;
    const dir = this.dir(id);
    fs.writeFileSync(path.join(dir, 'shots', name), jpeg);
    const shot: SessionShot = { name, t: Math.round(t), reason: reason.slice(0, 40), w: size.w, h: size.h };
    fs.appendFileSync(path.join(dir, 'shots.jsonl'), JSON.stringify(shot) + '\n');
    st.meta.counts.shots++;
    st.dirty = true;
    return shot;
  }

  shots(id: string): SessionShot[] {
    return readJsonl<SessionShot>(path.join(this.dir(id), 'shots.jsonl')).sort((a, b) => a.t - b.t);
  }

  shotFile(id: string, name: string): string {
    if (!/^[\w.-]+\.jpg$/.test(name)) throw new HttpError(400, 'Bad file name');
    const file = path.join(this.dir(id), 'shots', name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'No such screenshot');
    return file;
  }

  /**
   * A piece of screen recording. Each recording (one per share of the screen,
   * so a reload starts another) is its own file; `n` numbers the pieces of
   * one recording so a resent piece isn't written twice.
   */
  appendVideo(id: string, chunk: Buffer, info: { mime: string; startedAt: number; n?: number }): void {
    const st = this.state(id);
    if (st.meta.status !== 'recording') throw new HttpError(409, 'This session has ended');
    const parts = videoParts(st.meta);
    let part = parts[parts.length - 1];
    if (!part || part.startedAt !== info.startedAt) {
      part = { startedAt: info.startedAt, bytes: 0, file: parts.length ? `video-${parts.length + 1}.webm` : 'video.webm' };
      parts.push(part);
    }
    if (info.n !== undefined) {
      if (info.n <= (st.videoPieces.get(part.file) ?? -1)) return;
      st.videoPieces.set(part.file, info.n);
    }
    fs.appendFileSync(path.join(this.dir(id), part.file), chunk);
    part.bytes += chunk.length;
    st.lastActivity = Date.now();
    st.meta.video = { mime: info.mime, startedAt: parts[0].startedAt, bytes: parts.reduce((sum, p) => sum + p.bytes, 0), parts };
    st.dirty = true;
  }

  /** The file of a recording (1 is the first). */
  videoFile(id: string, part = 1): string | null {
    const p = videoParts(this.meta(id))[part - 1];
    const file = p && path.join(this.dir(id), p.file);
    return file && fs.existsSync(file) ? file : null;
  }

  saveAnalysis(id: string, a: SessionAnalysis): void {
    writeFileAtomic(path.join(this.dir(id), 'analysis.json'), JSON.stringify(a));
  }

  analysis(id: string): SessionAnalysis | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'analysis.json'), 'utf8')) as SessionAnalysis;
    } catch {
      return null;
    }
  }

  /** The report in the language spoken; a new one replaces its translation too. */
  saveReport(id: string, r: SessionReport): void {
    const dir = this.dir(id);
    writeFileAtomic(path.join(dir, 'report.json'), masked(r));
    for (const lang of ['en', 'ar']) fs.rmSync(path.join(dir, `report-${lang}.json`), { force: true });
  }

  report(id: string): SessionReport | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'report.json'), 'utf8')) as SessionReport;
    } catch {
      return null;
    }
  }

  saveTranslation(id: string, r: SessionReport): void {
    writeFileAtomic(path.join(this.dir(id), `report-${r.lang}.json`), masked(r));
  }

  /** The report in the other language, once written. */
  translation(id: string): SessionReport | null {
    const main = this.report(id);
    if (!main) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), `report-${main.lang === 'ar' ? 'en' : 'ar'}.json`), 'utf8')) as SessionReport;
    } catch {
      return null;
    }
  }

  saveVerification(id: string, v: SessionVerification): void {
    writeFileAtomic(path.join(this.dir(id), 'verification.json'), JSON.stringify(v, null, 1));
  }

  verification(id: string): SessionVerification | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'verification.json'), 'utf8')) as SessionVerification;
    } catch {
      return null;
    }
  }

  decisions(id: string): ReportDecisions {
    try {
      return { ...NO_DECISIONS, ...(JSON.parse(fs.readFileSync(path.join(this.dir(id), 'decisions.json'), 'utf8')) as Partial<ReportDecisions>) };
    } catch {
      return { ...NO_DECISIONS };
    }
  }

  saveDecisions(id: string, d: ReportDecisions): ReportDecisions {
    const clean: ReportDecisions = { skipped: Array.from(new Set(d.skipped.map((x) => String(x).slice(0, 200)))).slice(0, 200) };
    writeFileAtomic(path.join(this.dir(id), 'decisions.json'), JSON.stringify(clean));
    return clean;
  }

  remove(id: string): void {
    const dir = this.dir(id);
    this.open.delete(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Forget in-memory state for sessions that are done (they reload from disk on demand). */
  release(id: string): void {
    const st = this.open.get(id);
    if (st && st.meta.status !== 'recording') {
      if (st.dirty) this.saveMeta(st.meta);
      this.open.delete(id);
    }
  }
}

/**
 * A report as it is kept: what the AI wrote may repeat a key or a card number it saw (an older plugin's screenshot,
 * a response body), and every text in it is masked before it is saved, shown, exported or sent anywhere.
 */
function masked(r: SessionReport): string {
  return JSON.stringify(r, (_key, value: unknown) => (typeof value === 'string' ? maskSecrets(value) : value), 1);
}
