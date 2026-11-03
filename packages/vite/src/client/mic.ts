/**
 * Continuous microphone capture for session narration: 16 kHz mono 16-bit
 * PCM in half-second chunks, each stamped with the wall-clock time of its
 * first sample so narration lines up with what happened on screen.
 */

const RATE = 16000;
const CHUNK = RATE / 2;

// Inline so it works from any page (the studio, or the app's own tab) without a separate file.
const WORKLET = `class C extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(512);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===512){this.port.postMessage({time:currentTime+(k+1)/sampleRate,data:this.b.slice(0)});this.n=0}}}return true}}registerProcessor('saywright-session-mic',C)`;

interface MicChunk {
  /** Wall-clock ms of the first sample. */
  t: number;
  pcm: Int16Array;
}

export class MicStream {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private buf = new Int16Array(CHUNK);
  private fill = 0;
  private bufT = 0;
  private paused = false;
  private lastPerf = 0;
  /** Smoothed loudness 0..1 for a meter. */
  level = 0;
  /** Wall-clock ms of the last moment that sounded like speech. */
  lastVoice = 0;
  /** Wall-clock ms of the last sound of any kind (a muted or dead microphone sends none). */
  lastSound = 0;
  /** When capture started (wall-clock ms). */
  startedAt = 0;
  private noise = 0.004;
  private streak = 0;

  constructor(
    private onChunk: (c: MicChunk) => void,
    /** Called when speech starts after a pause (for a screenshot of what is being talked about). */
    private onSpeechStart?: (t: number) => void,
  ) {}

  get open(): boolean {
    return !!this.node;
  }

  async start(deviceId?: string | null): Promise<void> {
    if (this.node) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Unprocessed: noise suppression and gain control distort speech enough to change what the recogniser hears.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    const ctx = new AudioContext({ sampleRate: RATE });
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'saywright-session-mic');
    node.port.onmessage = (e: MessageEvent<{ time: number; data: Float32Array }>) => {
      if (this.ctx) this.ingest(e.data.data, this.toWall(e.data.time));
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    this.node = node;
    this.startedAt = Date.now();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  }

  /** Audio-clock seconds → wall-clock ms, kept monotonic. */
  private toWall(contextTime: number): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    let perf: number;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) perf = ts.performanceTime + (contextTime - ts.contextTime) * 1000;
    else perf = performance.now() - (ctx.currentTime - contextTime) * 1000;
    perf = Math.max(perf, this.lastPerf);
    this.lastPerf = perf;
    return performance.timeOrigin + perf;
  }

  private ingest(data: Float32Array, endT: number): void {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    this.level = Math.max(rms * 6, this.level * 0.85);
    // Even a silent room is above this (a microphone's own hiss); a muted or dead one sends exact zeros.
    if (rms > 0.00002) this.lastSound = endT;
    // Adaptive noise floor; speech is sustained sound above it.
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.999 + rms * 0.001;
    if (rms > Math.max(0.01, this.noise * 3)) {
      this.streak++;
      if (this.streak === 3) {
        if (endT - this.lastVoice > 1500) this.onSpeechStart?.(endT);
        this.lastVoice = endT;
      } else if (this.streak > 3) this.lastVoice = endT;
    } else this.streak = 0;

    if (this.paused) return;
    const firstT = endT - (data.length / RATE) * 1000;
    let i = 0;
    while (i < data.length) {
      if (this.fill === 0) this.bufT = firstT + (i / RATE) * 1000;
      const take = Math.min(CHUNK - this.fill, data.length - i);
      for (let k = 0; k < take; k++) {
        const v = Math.max(-1, Math.min(1, data[i + k]));
        this.buf[this.fill + k] = v < 0 ? v * 32768 : v * 32767;
      }
      this.fill += take;
      i += take;
      if (this.fill === CHUNK) this.flush();
    }
  }

  /** Send whatever is buffered (also on pause and stop, so nothing is lost). */
  flush(): void {
    if (!this.fill) return;
    this.onChunk({ t: Math.round(this.bufT), pcm: this.buf.slice(0, this.fill) });
    this.fill = 0;
  }

  /** Drop what is buffered and not sent yet (heard before recording started). */
  discard(): void {
    this.fill = 0;
  }

  setPaused(paused: boolean): void {
    if (paused) this.flush();
    this.paused = paused;
  }

  async stop(): Promise<void> {
    this.flush();
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.level = 0;
  }
}
