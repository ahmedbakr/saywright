/**
 * Voice input for the studio. Combines:
 * - the studio's own microphone capture (keeps the moment before you press
 *   Space, measures loudness, finds where you started and stopped talking),
 * - the browser's recogniser (live words while you talk, strong language model),
 * - the on-device Moonshine model (private, never misses the first word,
 *   checks every candidate against the actual audio, rescues short commands).
 * The engine setting decides which of the two recognisers run.
 *
 * Each press is its own utterance. You can talk again while the last one is
 * still being processed: the microphone never stops recording in between.
 */
import { AudioCapture, RATE, type Span } from './capture';
import { SHORT_COMMANDS, alignWords, chooseWithoutScores, pick, plausible, sameWords, soundAlikes, understood, type Candidate, type CandidateSource } from './choose';
import { arabicCommand } from '@shared/arabic-commands';
import { ServerAsr } from './server-asr';
import { SpeechController, type Word } from './speech';

type VoiceEngine = 'auto' | 'browser' | 'device';
export type VoiceState = 'idle' | 'starting' | 'listening' | 'finishing';

export interface VoiceFinal {
  text: string;
  words: Word[];
  /** Word times are when the words were spoken (not when a recogniser reported them). */
  aligned: boolean;
  source: CandidateSource;
  /** From the start to the end of speech: what you pointed at during it counts. */
  span: Span;
  /** The browser's guesses, best first. */
  browser: string[];
  /** Why the browser's recogniser couldn't listen, if it failed. */
  browserError: string | null;
  /** The on-device transcript ('' when it heard nothing or didn't run). */
  device: string;
  /** Loudest moment (RMS, 0..1). */
  loudness: number;
  /** From letting go to knowing what was said. */
  ms: number;
}

/** Audio kept from before the key press. */
const PRE_ROLL_MS = 600;
/** Keep listening a moment after release so the last word isn't cut. */
const TAIL_MS = 350;
/** Utterances with less speech than this can be checked against the short commands. */
const SHORT_MS = 1700;
/** With the browser recogniser running, longer requests are left to it. */
const LONG_MS = 6000;
/** How long to wait for the browser's transcript after it stops. */
const WEB_WAIT_MS = 2500;
const MODEL_BASE = '/models/moonshine/tiny';
/** Why it's unavailable when its files aren't there: Settings → Voice offers the download (or the setup command). */
export const NOT_DOWNLOADED = 'The on-device speech model isn’t downloaded.';

interface AsrFinal {
  text: string;
  score: number;
  ms: number;
}

interface WebResult {
  text: string;
  words: Word[];
  alternatives: string[];
}
const NO_WEB: WebResult = { text: '', words: [], alternatives: [] };

const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

type ModelState = 'idle' | 'loading' | 'ready' | 'unavailable';

/** The on-device model, running in a worker. */
class AsrClient {
  state: ModelState = 'idle';
  /** Why it is unavailable. */
  reason = '';
  onChange: ((state: ModelState, reason: string) => void) | null = null;
  private worker: Worker | null = null;
  private loading: Promise<boolean> | null = null;
  private seq = 0;
  private waiting = new Map<number, (m: unknown) => void>();
  private busy = false;

  load(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.state === 'unavailable') return Promise.resolve(false);
    this.loading ??= this.boot();
    return this.loading;
  }

  private setState(state: ModelState, reason = ''): void {
    this.state = state;
    this.reason = reason;
    this.onChange?.(state, reason);
  }

  private async boot(): Promise<boolean> {
    this.setState('loading');
    let reason = '';
    try {
      const head = await fetch(`${MODEL_BASE}/encoder_model.onnx`, { method: 'HEAD' });
      // A dev server answers a missing file with its page (200, text/html): that isn't the model either.
      if (!head.ok || /text\/html/.test(head.headers.get('content-type') ?? '')) throw new Error(NOT_DOWNLOADED);
      const worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 30_000);
        worker.onmessage = (e: MessageEvent<{ type: string; id?: number; message?: string }>) => {
          const m = e.data;
          if (m.type === 'loaded') {
            clearTimeout(timer);
            resolve(true);
          } else if (m.type === 'error' && !m.id) {
            reason = m.message ?? '';
            clearTimeout(timer);
            resolve(false);
          } else if (m.id) {
            const cb = this.waiting.get(m.id);
            this.waiting.delete(m.id);
            cb?.(m);
          }
        };
        worker.onerror = (e) => {
          reason = e.message;
          clearTimeout(timer);
          resolve(false);
        };
        // onnxruntime's WebAssembly: served from node_modules in development, built in with the worker otherwise.
        worker.postMessage({ type: 'load', base: new URL(MODEL_BASE, location.origin).href, wasmPaths: import.meta.env.DEV ? new URL('/ort/', location.origin).href : undefined });
      });
      if (!ok) throw new Error(reason || 'The speech model didn’t start in time.');
      // If the worker dies later (out of memory, say), stop waiting on it.
      worker.onerror = () => this.fail('The on-device speech model stopped working. Reload the studio to restart it.');
      this.setState('ready');
      return true;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private fail(reason: string): void {
    this.dispose();
    for (const cb of this.waiting.values()) cb({ type: 'error' });
    this.waiting.clear();
    this.setState('unavailable', reason);
  }

  private call<T>(msg: Record<string, unknown>, timeout: number, transfer: Transferable[] = []): Promise<T | null> {
    if (!this.worker || this.state !== 'ready') return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, timeout);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve((m as { type: string }).type === 'error' ? null : (m as T));
      });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Transcribe what has been said so far; skipped while the model is busy. */
  async partial(audio: Float32Array): Promise<string | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const r = await this.call<{ text: string }>({ type: 'partial', audio }, 4000, [audio.buffer]);
      return r?.text ?? null;
    } finally {
      this.busy = false;
    }
  }

  /** Transcribe an utterance (kept under `key` for scoring). */
  final(key: number, audio: Float32Array): Promise<AsrFinal | null> {
    return this.call<AsrFinal>({ type: 'final', key, audio }, 10_000, [audio.buffer]);
  }

  /** How well each sentence explains an utterance sent with final(). `prune` skips the unlikely ones. */
  async score(key: number, candidates: string[], prune = false): Promise<Record<string, number> | null> {
    const r = await this.call<{ scores: Record<string, number> }>({ type: 'score', key, candidates, prune }, 5000);
    return r?.scores ?? null;
  }

  /** Load it again, after it was unavailable (its files were just downloaded, say). */
  retry(): Promise<boolean> {
    if (this.state === 'unavailable') {
      this.loading = null;
      this.state = 'idle';
    }
    return this.load();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

interface Utterance {
  id: number;
  pressAt: number;
  liveAt: number;
  releasedAt: number;
  /** A new press during this one's release tail ends its audio there. */
  endCap: number;
  handsFree: boolean;
  live: boolean;
  useDevice: boolean;
  /** The studio server transcribes it (Arabic, on this computer). */
  useServer: boolean;
  useWeb: boolean;
  /** The browser recogniser is (or was) running for this utterance. */
  webStarted: boolean;
  webStopped: boolean;
  web: Promise<WebResult> | null;
  resolveWeb: ((r: WebResult) => void) | null;
  webWords: Word[];
  webError: string | null;
  timers: ReturnType<typeof setTimeout>[];
}

export class VoiceInput {
  engine: VoiceEngine = 'auto';
  lang = 'en-US';
  /** Hands-free: stop by itself after this much silence. */
  autoStopMs = 1300;

  onState: ((state: VoiceState) => void) | null = null;
  onWords: ((words: Word[], aligned: boolean) => void) | null = null;
  onFinal: ((final: VoiceFinal) => void) | null = null;
  onError: ((code: string, message: string) => void) | null = null;
  /** Hands-free mode heard nothing and gave up. */
  onNothing: (() => void) | null = null;

  readonly capture = new AudioCapture();
  readonly asr = new AsrClient();
  readonly server = new ServerAsr();
  /** How the last sentence was decided, for diagnosing recognition (devtools: __saywright.voice.debug). */
  debug: { candidates: Candidate[]; scores: Record<string, number> | null; chosen: string | null } | null = null;
  private web = new SpeechController();
  state: VoiceState = 'idle';

  private seq = 0;
  /** Bumped by cancel(): results of earlier utterances are dropped. */
  private gen = 0;
  private current: Utterance | null = null;
  private lastReleased: Utterance | null = null;
  private pending = 0;
  /** The utterance the browser recogniser is working for (it does one at a time). */
  private webOwner: Utterance | null = null;
  /** When the browser's recogniser last failed for good (no network, turned off): Auto skips it for a minute. */
  private webBrokenAt = -Infinity;

  constructor() {
    this.web.onWords = (words) => {
      const u = this.webOwner;
      if (!u) return;
      u.webWords = words;
      if (u === this.current) this.onWords?.(words, false);
    };
    this.web.onAudioStart = () => {
      if (this.webOwner && this.webOwner === this.current) this.goLive(this.webOwner);
    };
    this.web.onFinal = (text, words, alternatives) => {
      const u = this.webOwner;
      this.webOwner = null;
      u?.resolveWeb?.({ text, words, alternatives });
      // The next utterance may be waiting for the recogniser.
      setTimeout(() => {
        const next = this.current;
        if (next && next.useWeb && !next.webStarted && !this.webOwner) this.runWeb(next);
      }, 0);
    };
    this.web.onError = (code, message) => {
      if (code === 'network' || code === 'service-not-allowed') this.webBrokenAt = performance.now();
      const u = this.webOwner;
      this.webOwner = null;
      u?.resolveWeb?.(NO_WEB);
      if (!u) return;
      u.useWeb = false;
      u.webError = message;
      // With our own recording and the on-device model, the browser failing is not fatal.
      // (If our microphone is still opening, start() goes live, or reports the problem, once it has.)
      if ((u.useDevice && this.asr.state !== 'unavailable') || u.useServer) {
        if (u === this.current && this.capture.open) this.goLive(u);
        return;
      }
      this.onError?.(code, message);
      this.drop(u);
    };
  }

  static browserSupported(): boolean {
    return SpeechController.supported();
  }

  /** The in-browser model knows English only; Arabic goes to the studio server's model. */
  private get deviceOn(): boolean {
    return !this.arabic && (this.engine === 'device' || (this.engine === 'auto' && /^en\b/i.test(this.lang)));
  }

  private get arabic(): boolean {
    return /^ar\b/i.test(this.lang);
  }

  /** Arabic, transcribed on this computer by the studio server (when its model is installed). */
  private get serverOn(): boolean {
    return this.arabic && this.engine !== 'browser' && this.server.langs.has('ar');
  }

  /** Whether some way of recognising speech is available here. */
  get supported(): boolean {
    const mic = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    if (this.engine === 'device') return mic && (!this.arabic || this.serverOn);
    return VoiceInput.browserSupported() || ((this.deviceOn || this.serverOn) && mic);
  }

  /** Meter level, 0..1, for the waveform. */
  level(): number {
    return this.capture.sample();
  }

  /** Load the on-device model ahead of time (it takes a moment the first time). */
  warmUp(): void {
    if (this.deviceOn) void this.asr.load();
  }

  private sync(): void {
    const s: VoiceState = this.current ? (this.current.live ? 'listening' : 'starting') : this.pending ? 'finishing' : 'idle';
    if (s === this.state) return;
    this.state = s;
    this.onState?.(s);
  }

  async start(opts: { handsFree?: boolean } = {}): Promise<boolean> {
    if (this.current) return true;
    const now = performance.now();
    const u: Utterance = {
      id: ++this.seq,
      pressAt: now,
      liveAt: 0,
      releasedAt: 0,
      endCap: Infinity,
      handsFree: !!opts.handsFree,
      live: false,
      useDevice: this.deviceOn,
      useServer: this.serverOn,
      useWeb: this.engine !== 'device' && VoiceInput.browserSupported() && !(this.engine === 'auto' && (this.deviceOn || this.serverOn) && now - this.webBrokenAt < 60_000),
      webStarted: false,
      webStopped: false,
      web: null,
      resolveWeb: null,
      webWords: [],
      webError: null,
      timers: [],
    };
    // Talking again during the last utterance's release tail: that one ends here.
    const prev = this.lastReleased;
    if (prev && now < prev.releasedAt + TAIL_MS) {
      prev.endCap = now;
      this.endWeb(prev);
    }
    this.current = u;
    this.sync();

    const mic = this.capture.start();
    if (u.useDevice) void this.asr.load();
    if (u.useWeb) {
      u.web = new Promise((resolve) => (u.resolveWeb = resolve));
      if (!this.webOwner) this.runWeb(u);
    }
    const micOk = await mic;
    if (this.current !== u) return u.releasedAt > 0;
    if (!micOk && !u.useWeb) {
      this.onError?.('audio-capture', this.capture.error ?? 'No microphone available.');
      this.drop(u);
      return false;
    }
    // Our own recording runs (and kept the moment before the press): talk right away.
    // The browser alone needs its own microphone to be on first.
    if ((micOk && (u.useDevice || u.useServer)) || !u.useWeb) this.goLive(u);
    else u.timers.push(setTimeout(() => this.goLive(u), 1500));
    if (u.useDevice && !u.useWeb) this.startPartials(u);
    this.watchSilence(u);
    return true;
  }

  private runWeb(u: Utterance): void {
    this.web.lang = this.lang;
    this.webOwner = u;
    u.webStarted = true;
    if (!this.web.start()) {
      this.webOwner = null;
      u.useWeb = false;
      u.resolveWeb?.(NO_WEB);
      if (u === this.current && (this.capture.open || u.useDevice)) this.goLive(u);
    }
  }

  private endWeb(u: Utterance): void {
    if (this.webOwner !== u || u.webStopped) return;
    u.webStopped = true;
    this.web.stop();
  }

  private goLive(u: Utterance): void {
    if (this.current !== u || u.live) return;
    u.live = true;
    u.liveAt = performance.now();
    this.sync();
  }

  /** Hold-to-talk released, or hands-free asked to send. */
  stop(): void {
    const u = this.current;
    if (!u) return;
    u.releasedAt = performance.now();
    u.timers.forEach(clearTimeout);
    u.timers = [];
    this.current = null;
    this.lastReleased = u;
    this.pending++;
    this.sync();
    const gen = this.gen;
    setTimeout(() => void this.finish(u, gen), TAIL_MS);
  }

  setHandsFree(on: boolean): void {
    if (this.current) this.current.handsFree = on;
  }

  /** Stop listening and drop everything not yet delivered. */
  cancel(): void {
    this.gen++;
    const u = this.current;
    if (u) this.drop(u);
    if (this.webOwner) {
      this.webOwner.resolveWeb?.(NO_WEB);
      this.webOwner = null;
      this.web.cancel();
    }
    this.pending = 0;
    this.sync();
  }

  private drop(u: Utterance): void {
    u.timers.forEach(clearTimeout);
    u.timers = [];
    if (this.webOwner === u) {
      this.webOwner = null;
      this.web.cancel();
    }
    u.resolveWeb?.(NO_WEB);
    if (this.current === u) this.current = null;
    this.sync();
  }

  private startPartials(u: Utterance): void {
    u.timers.push(
      setInterval(async () => {
        if (this.current !== u || !u.live || this.asr.state !== 'ready') return;
        const t0 = u.pressAt - PRE_ROLL_MS;
        const t1 = performance.now();
        const voiced = this.capture.voiced(t0, t1, u.pressAt);
        if (!voiced) return;
        const text = await this.asr.partial(this.capture.slice(Math.max(t0, voiced.start - 250), t1));
        if (text && this.current === u && plausible(text)) this.onWords?.(alignWords(text, voiced.start, voiced.end), true);
      }, 700),
    );
  }

  /** Hands-free: send after a pause; give up if nothing is said. */
  private watchSilence(u: Utterance): void {
    u.timers.push(
      setInterval(() => {
        if (this.current !== u || !u.live || !u.handsFree) return;
        const now = performance.now();
        const lastWord = u.webWords.at(-1)?.t ?? 0;
        const lastVoice = this.capture.open ? this.capture.lastVoice : 0;
        const last = Math.max(lastWord, lastVoice);
        const spoke = last > u.pressAt;
        if (spoke && now - last > this.autoStopMs) this.stop();
        else if (!spoke && now - u.liveAt > 8000) {
          this.drop(u);
          this.onNothing?.();
        }
      }, 100),
    );
  }

  private modelReady(ms: number): Promise<boolean> {
    if (this.asr.state === 'ready') return Promise.resolve(true);
    return within(this.asr.load(), ms).then((ok) => ok === true);
  }

  private async finish(u: Utterance, gen: number): Promise<void> {
    try {
      if (gen !== this.gen) return;
      const t0 = u.pressAt - PRE_ROLL_MS;
      const t1 = Math.min(u.releasedAt + TAIL_MS, u.endCap);
      this.endWeb(u);
      this.capture.touch();
      const voiced = this.capture.open ? this.capture.voiced(t0, t1, u.pressAt) : null;
      if (u.useServer) return await this.finishOnServer(u, gen, t0, t1, voiced);
      const length = voiced ? voiced.end - voiced.start : 0;
      const canDevice = u.useDevice && !!voiced && this.asr.state !== 'unavailable';
      const transcribe = () => {
        const audio = this.capture.slice(Math.max(t0, voiced!.start - 250), Math.min(t1, voiced!.end + 300));
        if (audio.length < RATE * 0.2) return Promise.resolve(null);
        return this.modelReady(u.useWeb ? 4000 : 30_000).then((ok) => (ok ? this.asr.final(u.id, audio) : null));
      };

      // On-device: start right away, while the browser's transcript is on its way.
      // Long requests are left to the browser's language model, unless it heard nothing.
      let device = canDevice && (!u.useWeb || length <= LONG_MS) ? transcribe() : null;
      const web = u.web && u.webStarted ? ((await within(u.web, WEB_WAIT_MS)) ?? NO_WEB) : NO_WEB;
      if (!device && canDevice && !web.alternatives.length) device = transcribe();
      const dev = device ? await device : null;
      if (gen !== this.gen) return;

      const candidates: Candidate[] = web.alternatives.map((text, rank) => ({ text, source: 'browser', rank }));
      let scores: Record<string, number> | null = null;
      // Both recognisers heard the same thing: nothing to weigh.
      const agreed = !!dev && candidates.length > 0 && sameWords(candidates[0].text, dev.text);
      if (dev && !agreed) {
        if (dev.text && plausible(dev.text, dev.score, !candidates.length && u.webStarted)) candidates.push({ text: dev.text, source: 'device', rank: 0 });
        scores = {};
        if (candidates.some((c) => c.source === 'device')) scores[dev.text] = dev.score;
        // Maybe a studio word was misheard as a sound-alike ("make this beggar").
        const variants: Candidate[] = [];
        for (const from of candidates) {
          if (understood(from.text)) continue;
          for (const text of soundAlikes(from.text)) {
            if (!candidates.some((c) => c.text === text) && !variants.some((v) => v.text === text)) variants.push({ text, source: 'variant', rank: 0, from });
          }
        }
        const toScore = [...web.alternatives, ...variants.map((v) => v.text)];
        const more = toScore.length ? await this.asr.score(u.id, toScore) : {};
        if (gen !== this.gen) return;
        if (more) {
          Object.assign(scores, more);
          candidates.push(...variants);
        }
        // Without scores for the browser's guesses a comparison would be unfair: trust the browser.
        else scores = null;
        // Short, and nothing heard so far makes sense: check the audio against the short commands.
        const meanwhile = scores && pick(candidates, scores);
        if (scores && length < SHORT_MS && !(meanwhile && understood(meanwhile.text))) {
          const rescue = await this.asr.score(u.id, SHORT_COMMANDS, true);
          if (gen !== this.gen) return;
          for (const [text, score] of Object.entries(rescue ?? {})) {
            if (candidates.some((c) => c.text === text)) continue;
            candidates.push({ text, source: 'command', rank: 0 });
            scores![text] = score;
          }
        }
      }

      const choice = agreed ? candidates[0] : pick(candidates, scores);
      this.debug = { candidates: candidates.map(({ from, ...c }) => ({ ...c, ...(from ? { from: { ...from, from: undefined } } : {}) })), scores, chosen: choice?.text ?? null };
      const span = { start: voiced?.start ?? u.pressAt, end: voiced?.end ?? t1 };
      const info = { span, browser: web.alternatives, browserError: u.webError, device: dev?.text ?? '', loudness: this.capture.peak(t0, t1), ms: Math.round(performance.now() - u.releasedAt) };
      if (!choice) {
        this.onFinal?.({ text: '', words: [], aligned: false, source: 'browser', ...info });
        return;
      }
      // Word times: from the audio when we have it, else the browser's own timing.
      const fromWeb = !voiced && choice.source === 'browser' && choice.rank === 0 && web.words.length > 0;
      const words = fromWeb ? web.words : alignWords(choice.text, span.start, span.end);
      this.onFinal?.({ text: choice.text, words, aligned: !fromWeb, source: choice.source, ...info });
    } finally {
      if (gen === this.gen) this.pending = Math.max(0, this.pending - 1);
      this.sync();
    }
  }

  /** Arabic: the studio server's model and the browser's recogniser, each on its own, then the better of the two. */
  private async finishOnServer(u: Utterance, gen: number, t0: number, t1: number, voiced: Span | null): Promise<void> {
    const audio = voiced ? this.capture.slice(Math.max(t0, voiced.start - 250), Math.min(t1, voiced.end + 300)) : null;
    const server = audio && audio.length >= RATE * 0.2 ? this.server.transcribe(audio, 'ar') : Promise.resolve(null);
    const web = u.web && u.webStarted ? ((await within(u.web, WEB_WAIT_MS)) ?? NO_WEB) : NO_WEB;
    const local = (await within(server, 15_000)) ?? null;
    if (gen !== this.gen) return;
    const choice = chooseWithoutScores(web.alternatives, local?.text ?? '', (text) => !!arabicCommand(text) || understood(text));
    this.debug = { candidates: [...web.alternatives.map((text, rank): Candidate => ({ text, source: 'browser', rank })), ...(local?.text ? [{ text: local.text, source: 'device' as const, rank: 0 }] : [])], scores: null, chosen: choice?.text ?? null };
    const span = { start: voiced?.start ?? u.pressAt, end: voiced?.end ?? t1 };
    const info = { span, browser: web.alternatives, browserError: u.webError, device: local?.text ?? '', loudness: this.capture.peak(t0, t1), ms: Math.round(performance.now() - u.releasedAt) };
    if (!choice) {
      this.onFinal?.({ text: '', words: [], aligned: false, source: 'browser', ...info });
      return;
    }
    this.onFinal?.({ text: choice.text, words: alignWords(choice.text, span.start, span.end), aligned: true, source: choice.source, ...info });
  }
}
