/**
 * Hand tracking off the main thread. Each camera frame arrives as a VideoFrame
 * (or an ImageBitmap), is run through MediaPipe's hand landmarker here, closed,
 * and only the landmarks go back. The page (and the app in the studio's frame,
 * which shares its thread) never waits on the model.
 */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { blockUsageLog } from './usage-log';

type In =
  | { type: 'init'; model: string; wasm: string; numHands: number }
  | { type: 'frame'; image: VideoFrame | ImageBitmap; t: number; aspect: number }
  | { type: 'numHands'; n: number }
  | { type: 'close' };

let landmarker: HandLandmarker | null = null;
let delegate: 'GPU' | 'CPU' = 'GPU';
let create: ((d: 'GPU' | 'CPU') => Promise<HandLandmarker>) | null = null;
/** How long the first frames took on the GPU, to tell a slow one. */
const firstMs: number[] = [];
let switching = false;
/** The number of hands to look for, for a landmarker made later (see toCpu). */
let setHands: (n: number) => void = () => undefined;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

// This worker only tracks hands: MediaPipe's usage log stays blocked for as long as it runs.
blockUsageLog(self);

/** WebGL drawn by the processor rather than a graphics card (a VM, a blocklisted GPU): the model's GPU path is many times slower there than its CPU path. */
function softwareGl(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return true;
  }
}

async function init(m: Extract<In, { type: 'init' }>): Promise<void> {
  const fileset = await FilesetResolver.forVisionTasks(m.wasm, true);
  let numHands = m.numHands;
  create = (d) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: m.model, delegate: d },
      runningMode: 'VIDEO',
      numHands,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
      ...(d === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
    });
  setHands = (n) => (numHands = n);
  delegate = softwareGl() ? 'CPU' : 'GPU';
  try {
    landmarker = await create(delegate);
  } catch {
    delegate = 'CPU';
    landmarker = await create('CPU');
  }
  post({ type: 'ready', delegate });
}

/** The GPU turned out slow on the first frames: the CPU it is. */
async function toCpu(): Promise<void> {
  if (switching || !create) return;
  switching = true;
  try {
    const cpu = await create('CPU');
    landmarker?.close();
    landmarker = cpu;
    delegate = 'CPU';
    post({ type: 'delegate', delegate });
  } catch {
    /* keep the GPU one */
  }
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      init(m).catch((err) => post({ type: 'failed', message: err instanceof Error ? err.message : String(err) }));
      return;
    case 'frame': {
      try {
        if (!landmarker) return post({ type: 'result', t: m.t, aspect: m.aspect, hands: [] });
        const start = performance.now();
        const r = landmarker.detectForVideo(m.image, m.t);
        const ms = performance.now() - start;
        if (delegate === 'GPU' && firstMs.length < 12) {
          firstMs.push(ms);
          const sorted = firstMs.slice(2).sort((a, b) => a - b);
          if (firstMs.length === 12 && sorted[Math.floor(sorted.length / 2)] > 70) void toCpu();
        }
        const hands = r.landmarks.map((landmarks, i) => ({
          landmarks,
          handedness: r.handedness[i]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right',
          score: r.handedness[i]?.[0]?.score ?? 0,
        }));
        post({ type: 'result', t: m.t, aspect: m.aspect, hands, ms });
      } catch (err) {
        post({ type: 'result', t: m.t, aspect: m.aspect, hands: [], error: err instanceof Error ? err.message : String(err) });
      } finally {
        // A frame holds video memory until it is closed.
        m.image.close();
      }
      return;
    }
    case 'numHands':
      setHands(m.n);
      void landmarker?.setOptions({ numHands: m.n }).catch(() => undefined);
      return;
    case 'close':
      landmarker?.close();
      landmarker = null;
      return;
  }
};
