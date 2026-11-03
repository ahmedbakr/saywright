/**
 * The studio's own microphone capture, at 16 kHz.
 *
 * It keeps the last few seconds in memory so speech that starts a moment
 * before you press Space (or before the browser's recogniser wakes up) is not
 * lost, measures loudness for the waveform, and finds where speech starts and
 * ends. Audio stays in this tab.
 */
export const RATE = 16000;
const KEEP_MS = 45_000;
const IDLE_CLOSE_MS = 120_000;
/** Speech is sustained sound: at least this many loud 32 ms blocks in a row (a key click is one). */
const SUSTAIN_BLOCKS = 3;
/** Pauses shorter than this stay inside one stretch of speech. */
const MERGE_GAP_MS = 220;
/** Talk that stopped this long before the press was a remark to someone else. */
const LEAD_GAP_MS = 220;
/** Speech edges are placed to within this many samples (8 ms), so the same words give the model the same audio. */
const EDGE_WINDOW = 128;

interface Run extends Span {
  sustained: boolean;
  first: number;
  last: number;
}

interface Chunk {
  /** performance.now() of the chunk's last sample. */
  t: number;
  data: Float32Array;
  rms: number;
}

export interface Span {
  start: number;
  end: number;
}

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Chunk[] = [];
  private opening: Promise<boolean> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private noise = 0.004;
  private lastT = 0;
  private streak = 0;
  /** Smoothed loudness, 0..1, for the waveform. */
  level = 0;
  /** performance.now() of the last block of sustained, speech-like sound. */
  lastVoice = 0;
  error: string | null = null;

  get open(): boolean {
    return !!this.node;
  }

  /** Open the microphone (or keep it open). Resolves false when it isn't available. */
  start(): Promise<boolean> {
    this.touch();
    if (this.node) return Promise.resolve(true);
    this.opening ??= this.openMic().finally(() => (this.opening = null));
    return this.opening;
  }

  private async openMic(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        // Unprocessed audio: noise suppression and automatic gain distort speech enough to change what the model hears.
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule('/voice-capture-worklet.js');
      const source = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, 'saywright-capture');
      node.port.onmessage = (e: MessageEvent<{ time: number; data: Float32Array }>) => this.ingest(e.data.data, this.toPerf(e.data.time));
      // Some browsers only run nodes that reach the output; a muted gain keeps it silent.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(ctx.destination);
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      this.node = node;
      this.error = null;
      return true;
    } catch (err) {
      const name = (err as Error)?.name;
      this.error =
        name === 'NotAllowedError'
          ? 'Microphone is blocked. Allow it in the address bar (and on macOS in System Settings → Privacy & Security → Microphone).'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : `Microphone unavailable: ${(err as Error)?.message ?? err}`;
      this.close();
      return false;
    }
  }

  /** Audio-clock time to performance.now(), so audio lines up with where you were pointing. */
  private toPerf(contextTime: number): number {
    const ctx = this.ctx;
    let t = performance.now();
    if (ctx?.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime !== undefined && ts.performanceTime) t = ts.performanceTime + (contextTime - ts.contextTime) * 1000;
    }
    // Never go backwards (clock corrections, a busy main thread).
    t = Math.max(t, this.lastT + 1);
    this.lastT = t;
    return t;
  }

  /** Add a block of samples that ended at `t` (performance.now() time). */
  ingest(data: Float32Array, t: number): void {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    this.chunks.push({ t, data, rms });
    while (this.chunks.length && this.chunks[0].t < t - KEEP_MS) this.chunks.shift();
    // Adaptive noise floor: falls fast, rises slowly.
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.998 + rms * 0.002;
    this.streak = rms > this.threshold() ? this.streak + 1 : 0;
    if (this.streak >= SUSTAIN_BLOCKS) this.lastVoice = t;
    const target = Math.min(1, rms * 9);
    this.level = target > this.level ? this.level * 0.35 + target * 0.65 : this.level * 0.75 + target * 0.25;
  }

  private threshold(): number {
    return Math.max(0.008, this.noise * 3.2);
  }

  /** Decay the meter between blocks so it falls smoothly when audio stops. */
  sample(): number {
    if (!this.node) this.level *= 0.85;
    return this.level;
  }

  /** Audio captured between two performance.now() times, to the sample. */
  slice(t0: number, t1: number): Float32Array {
    const parts: Float32Array[] = [];
    for (const c of this.chunks) {
      const begin = c.t - (c.data.length / RATE) * 1000;
      if (c.t <= t0 || begin >= t1) continue;
      const from = Math.max(0, Math.round(((t0 - begin) / 1000) * RATE));
      const to = Math.min(c.data.length, Math.round(((t1 - begin) / 1000) * RATE));
      if (to > from) parts.push(c.data.subarray(from, to));
    }
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Loudest block within [t0, t1], as RMS (0..1). */
  peak(t0: number, t1: number): number {
    let max = 0;
    for (const c of this.chunks) if (c.t >= t0 && c.t <= t1 + 50 && c.rms > max) max = c.rms;
    return max;
  }

  /**
   * Where you spoke within [t0, t1]: from the first to the last stretch of
   * sustained sound. Clicks (a key press) don't count, and neither does talk
   * that ended well before `pressAt` (a remark before you pressed Space).
   */
  voiced(t0: number, t1: number, pressAt = t0): Span | null {
    const threshold = this.threshold();
    const runs: Run[] = [];
    let run: Run | null = null;
    let streak = 0;
    this.chunks.forEach((c, i) => {
      if (c.t < t0 || c.t > t1 + 50) return;
      if (c.rms <= threshold) {
        streak = 0;
        return;
      }
      streak++;
      const begin = c.t - (c.data.length / RATE) * 1000;
      if (run && begin - run.end <= MERGE_GAP_MS) {
        run.end = c.t;
        run.last = i;
      } else {
        run = { start: begin, end: c.t, sustained: false, first: i, last: i };
        runs.push(run);
      }
      if (streak >= SUSTAIN_BLOCKS) run.sustained = true;
    });
    const kept = runs.filter((r) => r.sustained && r.end >= pressAt - LEAD_GAP_MS);
    if (!kept.length) return null;
    const first = kept[0];
    const last = kept[kept.length - 1];
    return { start: this.edge(first.first, threshold, 'start') ?? first.start, end: this.edge(last.last, threshold, 'end') ?? last.end };
  }

  /** The exact moment sound crosses the threshold around block `i`: the first one going into it, or the last one leaving it. */
  private edge(i: number, threshold: number, which: 'start' | 'end'): number | null {
    let found: number | null = null;
    for (const j of which === 'start' ? [i - 1, i] : [i, i + 1]) {
      const c = this.chunks[j];
      if (!c) continue;
      const begin = c.t - (c.data.length / RATE) * 1000;
      for (let k = 0; k + EDGE_WINDOW <= c.data.length; k += EDGE_WINDOW) {
        let sum = 0;
        for (let m = k; m < k + EDGE_WINDOW; m++) sum += c.data[m] * c.data[m];
        if (Math.sqrt(sum / EDGE_WINDOW) <= threshold) continue;
        if (which === 'start') return begin + (k / RATE) * 1000;
        found = begin + ((k + EDGE_WINDOW) / RATE) * 1000;
      }
    }
    return found;
  }

  /** In use: close the microphone only after a while without use, so it isn't left on. */
  touch(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  close(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.node?.port.close();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.chunks = [];
    this.level = 0;
  }
}
