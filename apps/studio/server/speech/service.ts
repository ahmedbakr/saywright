/**
 * Local speech recognition for the studio: Arabic and English, on this
 * computer, in a child process (see worker.mjs). Also installs models.
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SpeechStatus } from '../../shared/api.ts';
import { download, extractTarBz2 } from '../download.ts';
import { MODELS, RELEASE, VAD_SHA256, VAD_URL, isInstalled, modelById, modelDir, narrationPlan, pickModel, type SpeechLang, type SpeechModel } from './catalog.ts';

const RATE = 16000;

interface Transcription {
  text: string;
  ms: number;
  model: string;
}

export interface Segment {
  /** Sample offsets in the stream. */
  start: number;
  end: number;
  text: string;
  ms: number;
  model: string;
}

const ENGINE_STOPPED = 'Speech engine stopped';

interface StreamHandlers {
  onSegment: (s: Segment) => void;
  closed?: () => void;
  /** A sentence arrived (the engine is still working through the stream). */
  progress?: () => void;
}

/** The engine and its models (a few GB for the larger ones) are let go after this long unused; the next request starts them again. */
const IDLE_MS = 10 * 60_000;

export class SpeechService {
  private child: ChildProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The engine being let go for being idle: its exit isn't a crash. */
  private retiring: ChildProcess | null = null;
  /** The newest engine process (it becomes `child` once ready). */
  private spawned: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private runtime: SpeechStatus['runtime'] = 'starting';
  private runtimeError = '';
  private version = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Transcription) => void; reject: (e: Error) => void; model: string }>();
  private loaded = new Map<string, Promise<void>>();
  private loadWaiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private streams = new Map<string, StreamHandlers>();
  private installing = new Map<string, number>();
  private installErrors = new Map<string, string>();
  private crashes = 0;

  constructor(
    /** Where models live: <studio home>/.saywright/speech. */
    readonly root: string,
    /** worker.mjs (the server code is bundled with the Vite config, so it can't find it by itself). */
    private workerPath: string,
    private emit: (event: string, data: unknown) => void,
    private preferred: () => Partial<Record<SpeechLang, string | null>> = () => ({}),
    private idleMs = IDLE_MS,
  ) {
    fs.mkdirSync(root, { recursive: true });
  }

  get vadPath(): string {
    return path.join(this.root, 'silero_vad.onnx');
  }

  /** The native runtime ships per platform; this checks it resolves without loading it. */
  private runtimeAvailable(): boolean {
    try {
      createRequire(import.meta.url).resolve('sherpa-onnx-node');
      return true;
    } catch {
      return false;
    }
  }

  status(): SpeechStatus {
    const pref = this.preferred();
    return {
      runtime: this.runtimeAvailable() ? this.runtime : 'missing',
      runtimeError: this.runtimeError,
      version: this.version,
      models: MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        langs: m.langs,
        sizeMb: m.sizeMb,
        wordErrors: m.wordErrors,
        installed: isInstalled(this.root, m),
        installing: this.installing.get(m.id) ?? null,
        error: this.installErrors.get(m.id) ?? null,
      })),
      active: { ar: pickModel(this.root, 'ar', pref.ar)?.id ?? null, en: pickModel(this.root, 'en', pref.en)?.id ?? null },
    };
  }

  available(lang: SpeechLang): boolean {
    return this.runtimeAvailable() && this.runtime !== 'failed' && !!pickModel(this.root, lang, this.preferred()[lang]);
  }

  // ---- the worker process -----------------------------------------------------

  /** Whether the engine process is up (it starts on the first request and stops when idle). */
  get running(): boolean {
    return !!this.child?.connected;
  }

  /** Something used the engine: it stays up until nothing has for `idleMs`. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.retireIfIdle(), this.idleMs);
    this.idleTimer.unref?.();
  }

  private retireIfIdle(): void {
    this.idleTimer = null;
    if (this.starting || this.streams.size || this.pending.size || this.loadWaiters.size) return this.touch();
    const child = this.child;
    if (!child) return;
    this.retiring = child;
    this.loaded.clear();
    child.kill();
  }

  private start(): Promise<ChildProcess> {
    this.touch();
    if (this.child?.connected) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.runtime = 'starting';
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      const child = fork(this.workerPath, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      this.spawned = child;
      this.loaded.clear();
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      const fail = (message: string) => {
        this.runtime = 'failed';
        this.runtimeError = message;
        this.starting = null;
        reject(new Error(message));
      };
      child.on('message', (m: Record<string, unknown>) => this.onMessage(child, m, resolve, fail));
      child.on('error', (err) => fail(err.message));
      child.on('exit', (code, signal) => {
        const retired = this.retiring === child;
        if (retired) this.retiring = null;
        // One let go earlier can exit after its successor started: the new one's state is none of its business.
        if (child !== this.spawned) return;
        this.spawned = null;
        if (this.child === child) this.child = null;
        this.loaded.clear();
        for (const [, p] of this.pending) p.reject(new Error(ENGINE_STOPPED));
        this.pending.clear();
        for (const [, w] of this.loadWaiters) w.reject(new Error(ENGINE_STOPPED));
        this.loadWaiters.clear();
        for (const [, s] of this.streams) s.closed?.();
        this.streams.clear();
        if (this.starting) fail(stderr.trim().split('\n').pop() || `Speech engine exited (${signal ?? code})`);
        else if (code !== 0 && !retired) {
          this.crashes++;
          this.runtimeError = stderr.trim().split('\n').pop() || `exited (${signal ?? code})`;
          // A crash restarts on the next request; three in a row means it can't run here.
          if (this.crashes >= 3) this.runtime = 'failed';
        }
        this.emit('speech', this.status());
      });
    });
    return this.starting;
  }

  private onMessage(child: ChildProcess, m: Record<string, unknown>, ready: (c: ChildProcess) => void, fail: (msg: string) => void): void {
    switch (m.type) {
      case 'ready':
        this.child = child;
        this.starting = null;
        this.runtime = 'ok';
        this.runtimeError = '';
        this.version = String(m.version ?? '');
        ready(child);
        break;
      case 'fatal':
        fail(String(m.message));
        break;
      case 'loaded':
        this.loadWaiters.get(String(m.key))?.resolve();
        this.loadWaiters.delete(String(m.key));
        this.crashes = 0;
        break;
      case 'load-error':
        this.loadWaiters.get(String(m.key))?.reject(new Error(String(m.message)));
        this.loadWaiters.delete(String(m.key));
        this.loaded.delete(String(m.key));
        break;
      case 'result': {
        const p = this.pending.get(m.id as number);
        this.pending.delete(m.id as number);
        p?.resolve({ text: String(m.text ?? ''), ms: Number(m.ms ?? 0), model: p.model });
        break;
      }
      case 'error': {
        const p = this.pending.get(m.id as number);
        this.pending.delete(m.id as number);
        p?.reject(new Error(String(m.message)));
        break;
      }
      case 'segment': {
        const s = this.streams.get(String(m.sid));
        s?.onSegment({ start: Number(m.start), end: Number(m.end), text: String(m.text ?? ''), ms: Number(m.ms ?? 0), model: String(m.key ?? '') });
        s?.progress?.();
        break;
      }
      case 'stream-closed': {
        const s = this.streams.get(String(m.sid));
        this.streams.delete(String(m.sid));
        s?.closed?.();
        break;
      }
    }
  }

  private async load(model: SpeechModel): Promise<ChildProcess> {
    const child = await this.start();
    await this.request(child, model);
    return child;
  }

  /** Ask the engine to load a model (once); resolves when it has. The request goes out before this returns. */
  private request(child: ChildProcess, model: SpeechModel): Promise<void> {
    let p = this.loaded.get(model.id);
    if (!p) {
      p = new Promise<void>((resolve, reject) => {
        this.loadWaiters.set(model.id, { resolve, reject });
        const threads = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1));
        child.send({
          type: 'load',
          key: model.id,
          config: { featConfig: { sampleRate: RATE, featureDim: 80 }, modelConfig: { ...model.config(modelDir(this.root, model)), numThreads: threads, provider: 'cpu', debug: 0 } },
          tail: model.tail,
        });
      });
      p.catch(() => undefined);
      this.loaded.set(model.id, p);
    }
    return p;
  }

  /** Load the model for a language ahead of time, so the first sentence isn't slow. */
  async warm(lang: SpeechLang): Promise<void> {
    const model = pickModel(this.root, lang, this.preferred()[lang]);
    if (model) await this.load(model).catch(() => undefined);
  }

  /** Load every model narration in this language (or both) uses, while the session is being set up. Resolves with whether they all loaded. */
  async warmNarration(mode: SpeechLang | 'auto'): Promise<boolean> {
    const plan = narrationPlan(this.root, mode, this.preferred());
    if (!plan || !this.canNarrate(mode)) return false;
    const child = await this.start().catch(() => null);
    if (!child) return false;
    const loaded = await Promise.all([plan.primary, plan.arabic, plan.latin].filter((p) => !!p).map((p) => this.request(child, p!.model).then(() => true, () => false)));
    return loaded.every(Boolean);
  }

  /**
   * Transcribe a short recording (a spoken command): jumps ahead of narration.
   * If the engine process dies meanwhile, it is tried once more on a fresh one.
   */
  async transcribe(samples: Float32Array, lang: SpeechLang, priority: 'high' | 'low' = 'high'): Promise<Transcription> {
    try {
      return await this.transcribeOnce(samples, lang, priority);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ENGINE_STOPPED) throw err;
      return this.transcribeOnce(samples, lang, priority);
    }
  }

  private async transcribeOnce(samples: Float32Array, lang: SpeechLang, priority: 'high' | 'low'): Promise<Transcription> {
    const model = pickModel(this.root, lang, this.preferred()[lang]);
    if (!model) throw new Error(`No ${lang === 'ar' ? 'Arabic' : 'English'} speech model installed`);
    const child = await this.load(model);
    const id = this.nextId++;
    return new Promise<Transcription>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, model: model.id });
      // A process that is going away can't take it: the same as dying with it in hand.
      const failed = (err: Error | null) => {
        if (!err || !this.pending.delete(id)) return;
        reject(new Error(ENGINE_STOPPED));
      };
      try {
        child.send({ type: 'transcribe', id, key: model.id, samples, options: model.options?.(lang) ?? {}, priority }, failed);
      } catch (err) {
        failed(err as Error);
      }
    });
  }

  // ---- live narration ---------------------------------------------------------

  /** Can narration in this language (or both) be transcribed here? */
  canNarrate(mode: SpeechLang | 'auto'): boolean {
    return this.runtimeAvailable() && this.runtime !== 'failed' && !!narrationPlan(this.root, mode, this.preferred());
  }

  /** Start live transcription of narration: `mode` is a language, or 'auto' for Arabic and English together. */
  async openStream(sid: string, mode: SpeechLang | 'auto', onSegment: (s: Segment) => void): Promise<string> {
    const plan = narrationPlan(this.root, mode, this.preferred());
    if (!plan) throw new Error(`No ${mode === 'en' ? 'English' : 'Arabic'} speech model installed`);
    if (!fs.existsSync(this.vadPath)) await download(VAD_URL, this.vadPath, undefined, VAD_SHA256);
    const passes = [plan.primary, plan.arabic, plan.latin].filter((p): p is NonNullable<typeof p> => !!p);
    // Transcription starts once the first model is ready; the others load meanwhile (the requests go out
    // before the stream opens, so a sentence that needs one of them waits for it in the engine).
    const child = await this.start();
    for (const p of passes.slice(1)) void this.request(child, p.model);
    await this.request(child, plan.primary.model);
    this.streams.set(sid, { onSegment });
    const wire = (p: (typeof passes)[number] | undefined) => (p ? { key: p.model.id, options: p.options } : undefined);
    child.send({
      type: 'stream-open',
      sid,
      plan: { primary: wire(plan.primary), arabic: wire(plan.arabic), latin: wire(plan.latin) },
      vad: this.vadPath,
      maxSpeech: Math.min(...passes.map((p) => p.model.maxSeconds), 15),
    });
    return plan.primary.model.id;
  }

  push(sid: string, samples: Float32Array): void {
    if (!this.streams.has(sid)) return;
    this.touch();
    this.child?.send({ type: 'stream-push', sid, samples });
  }

  /**
   * Finish a stream: resolves once its last sentence is transcribed. A long
   * recording can take a while on a slow computer, so it waits as long as
   * sentences keep coming, and gives up only after 90 s without one.
   */
  close(sid: string): Promise<void> {
    const s = this.streams.get(sid);
    if (!s || !this.child) return Promise.resolve();
    this.touch();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        s.closed = s.progress = undefined;
        resolve();
      };
      s.progress = () => {
        clearTimeout(timer);
        timer = setTimeout(done, 90_000);
      };
      s.closed = done;
      s.progress();
      this.child!.send({ type: 'stream-close', sid });
    });
  }

  hasStream(sid: string): boolean {
    return this.streams.has(sid);
  }

  // ---- installing models -----------------------------------------------------

  async install(id: string): Promise<void> {
    const model = modelById(id);
    if (!model) throw new Error('Unknown model');
    if (isInstalled(this.root, model) || this.installing.has(id)) return;
    this.installing.set(id, 0);
    this.installErrors.delete(id);
    this.emit('speech', this.status());
    const archive = path.join(this.root, `${model.archive}.tar.bz2`);
    try {
      if (!fs.existsSync(this.vadPath)) await download(VAD_URL, this.vadPath, undefined, VAD_SHA256);
      let lastEmit = 0;
      const progress = (f: number) => {
        this.installing.set(id, Math.round(f * 95));
        if (Date.now() - lastEmit > 400) {
          lastEmit = Date.now();
          this.emit('speech', this.status());
        }
      };
      await download(`${RELEASE}/${model.archive}.tar.bz2`, archive, progress, model.sha256);
      this.installing.set(id, 96);
      this.emit('speech', this.status());
      await extractTarBz2(archive, this.root);
      if (!isInstalled(this.root, model)) throw new Error('The download didn’t contain the expected files');
    } catch (err) {
      this.installErrors.set(id, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      fs.rmSync(archive, { force: true });
      fs.rmSync(`${archive}.part`, { force: true });
      this.installing.delete(id);
      this.emit('speech', this.status());
    }
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child?.kill();
    this.child = null;
  }
}

export function toFloat(pcm: Int16Array | Buffer): Float32Array {
  const ints = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = ints[i] / 32768;
  return out;
}
