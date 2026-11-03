/**
 * MediaPipe hand landmarker, running on-device. Camera frames never leave the
 * browser: the WASM runtime and the model are served by the local studio.
 *
 * The model runs in a worker: each camera frame is handed over as a VideoFrame
 * (no copy), at most one at a time, so a slow model skips frames instead of
 * holding up the page (or the app in the studio's frame, which shares its
 * thread). Where workers can't run it, it runs on the page as before, with
 * MediaPipe's code loaded only then.
 */
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import type { DetectedHand, HandFrame } from './engine';
import { blockUsageLog } from './usage-log';

const LOCAL_MODEL = '/models/hand_landmarker.task';
/**
 * MediaPipe's WebAssembly: from the studio's own server in development; in the built studio from jsDelivr, so the
 * package doesn't carry 13 MB for hand control (a Labs feature).
 */
const WASM = import.meta.env.DEV ? '/mediapipe/wasm' : `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${__MEDIAPIPE_VERSION__}/wasm`;
const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

async function modelPath(): Promise<string> {
  try {
    const res = await fetch(LOCAL_MODEL, { method: 'HEAD' });
    if (res.ok && Number(res.headers.get('content-length') ?? '1') > 1_000_000) return LOCAL_MODEL;
  } catch {
    /* fall back to the CDN */
  }
  return CDN_MODEL;
}

type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

/** WebGL drawn by the processor rather than a graphics card: the model's GPU path is many times slower there than its CPU one. */
function softwareGl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)));
  } catch {
    return true;
  }
}

type FromWorker =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'delegate'; delegate: 'GPU' | 'CPU' }
  | { type: 'failed'; message: string }
  | { type: 'result'; t: number; aspect: number; hands: DetectedHand[]; ms?: number; error?: string };

/** A frame given to the worker that hasn't come back after this long is given up on. */
const STALLED_MS = 3000;

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  /** Lets MediaPipe's usage log through the page's fetch again, once the landmarker on the page is gone. */
  private unblock: (() => void) | null = null;
  private worker: Worker | null = null;
  /** A frame is with the worker (sent at this time); 0: none. */
  private inFlight = 0;
  /** Where the model runs. */
  where: 'worker' | 'page' | null = null;
  /** How long the model takes per frame (ms, smoothed). */
  detectMs = 0;
  private video: VideoWithRvfc | null = null;
  private running = false;
  private lastVideoTime = -1;
  private frames: number[] = [];
  delegate: 'GPU' | 'CPU' = 'GPU';
  fps = 0;
  onFrame: ((frame: HandFrame) => void) | null = null;
  /**
   * Hands to look for. With fewer in view than this, MediaPipe runs its palm
   * detector on every frame looking for another: measured on this model, one
   * hand tracks in about half the time per frame of two (41–51 ms vs 80 ms
   * on a CPU), so one unless a preferred hand has to be picked out.
   */
  numHands = 1;

  async init(): Promise<void> {
    if (this.landmarker || this.worker) return;
    const path = await modelPath();
    if (typeof Worker !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        await this.initWorker(path);
        this.where = 'worker';
        return;
      } catch (err) {
        console.warn('[saywright] hand tracking couldn’t run in a worker; running it on the page', err);
        (this.worker as Worker | null)?.terminate();
        this.worker = null;
      }
    }
    await this.initPage(path);
    this.where = 'page';
  }

  private initWorker(model: string): Promise<void> {
    const w = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the model took too long to load')), 45_000);
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.delegate = m.delegate;
          w.onmessage = (ev: MessageEvent<FromWorker>) => this.onResult(ev.data);
          resolve();
        } else if (m.type === 'failed') {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(e.error ?? new Error(e.message || 'worker error'));
      };
      w.postMessage({ type: 'init', model: new URL(model, location.href).href, wasm: new URL(WASM, location.href).href, numHands: this.numHands });
    });
  }

  private onResult(m: FromWorker): void {
    if (m.type === 'delegate') this.delegate = m.delegate;
    if (m.type !== 'result') return;
    this.inFlight = 0;
    if (m.ms != null) this.detectMs = this.detectMs ? this.detectMs * 0.9 + m.ms * 0.1 : m.ms;
    if (m.error) console.warn('[saywright] hand tracking frame failed', m.error);
    if (!this.running) return;
    this.count(m.t);
    this.onFrame?.({ t: m.t, hands: m.hands, aspect: m.aspect });
  }

  private count(t: number): void {
    this.frames.push(t);
    while (this.frames.length && this.frames[0] < t - 1000) this.frames.shift();
    this.fps = this.frames.length;
  }

  private async initPage(path: string): Promise<void> {
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    this.unblock ??= blockUsageLog(window);
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: path, delegate },
      runningMode: 'VIDEO' as const,
      numHands: this.numHands,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    const first = softwareGl() ? 'CPU' : 'GPU';
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options(first));
      this.delegate = first;
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
  }

  async setNumHands(n: number): Promise<void> {
    if (n === this.numHands) return;
    this.numHands = n;
    this.worker?.postMessage({ type: 'numHands', n });
    await this.landmarker?.setOptions({ numHands: n }).catch(() => undefined);
  }

  start(video: HTMLVideoElement): void {
    this.video = video as VideoWithRvfc;
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
  }

  dispose(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.unblock?.();
    this.unblock = null;
    this.worker?.postMessage({ type: 'close' });
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    const v = this.video;
    if (v?.requestVideoFrameCallback) v.requestVideoFrameCallback(this.tick);
    else requestAnimationFrame(this.tick);
  }

  /** Hand the newest camera frame to the worker, unless it is still busy with the last one. */
  private send(v: HTMLVideoElement): void {
    const now = performance.now();
    if (this.inFlight && now - this.inFlight < STALLED_MS) return;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(v, { timestamp: Math.round(now * 1000) });
    } catch {
      return; // no frame to take yet
    }
    this.lastVideoTime = v.currentTime;
    this.inFlight = now;
    this.worker!.postMessage({ type: 'frame', image: frame, t: now, aspect: v.videoWidth / v.videoHeight }, [frame]);
  }

  private tick = (): void => {
    if (!this.running) return;
    const v = this.video;
    if (v && this.worker && v.readyState >= 2 && v.currentTime !== this.lastVideoTime && v.videoWidth > 0) this.send(v);
    else if (v && this.landmarker && v.readyState >= 2 && v.currentTime !== this.lastVideoTime && v.videoWidth > 0) {
      this.lastVideoTime = v.currentTime;
      const t = performance.now();
      try {
        const r = this.landmarker.detectForVideo(v, t);
        const hands: DetectedHand[] = r.landmarks.map((landmarks, i) => ({
          landmarks,
          handedness: r.handedness[i]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right',
          score: r.handedness[i]?.[0]?.score ?? 0,
        }));
        this.detectMs = this.detectMs ? this.detectMs * 0.9 + (performance.now() - t) * 0.1 : performance.now() - t;
        this.count(t);
        this.onFrame?.({ t, hands, aspect: v.videoWidth / v.videoHeight });
      } catch (err) {
        console.warn('[saywright] hand tracking frame failed', err);
      }
    }
    this.schedule();
  };
}
