/**
 * Hand landmark geometry. Landmarks follow MediaPipe's 21-point layout with
 * x, y normalised to the camera frame (y grows downwards) and z roughly on the
 * same scale as x. Distances are made isotropic with the frame's aspect ratio.
 */
export type Landmark = { x: number; y: number; z: number };

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
} as const;

/** [mcp, pip, dip, tip] for index, middle, ring and pinky. */
const FINGERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];

export const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export function dist(a: Landmark, b: Landmark, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y, (a.z - b.z) * aspect);
}

function sub(a: Landmark, b: Landmark, aspect: number): [number, number, number] {
  return [(a.x - b.x) * aspect, a.y - b.y, (a.z - b.z) * aspect];
}

function cosAngle(u: [number, number, number], v: [number, number, number]): number {
  const nu = Math.hypot(...u);
  const nv = Math.hypot(...v);
  if (!nu || !nv) return 0;
  return (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Wrist to middle-finger knuckle: a size reference that barely changes with pose. */
function handScale(lm: Landmark[], aspect: number): number {
  return (dist(lm[0], lm[9], aspect) + dist(lm[5], lm[17], aspect) * 1.25) / 2;
}

/**
 * 0 = curled, 1 = straight. Combines how far the tip reaches beyond the middle
 * joint (seen from the wrist) with how straight the finger is.
 */
function fingerExtension(lm: Landmark[], finger: readonly [number, number, number, number], aspect: number): number {
  const [mcp, pip, , tip] = finger;
  const reach = dist(lm[0], lm[tip], aspect) / Math.max(1e-6, dist(lm[0], lm[pip], aspect));
  const straight = cosAngle(sub(lm[pip], lm[mcp], aspect), sub(lm[tip], lm[pip], aspect));
  return clamp01((reach - 1.0) / 0.32) * 0.55 + clamp01((straight + 0.1) / 0.9) * 0.45;
}

/**
 * How far the index finger is bent: the sum of its three joint angles, in
 * degrees (0 = straight). Measured on real MediaPipe landmarks (Google's
 * rock-paper-scissors photos and OK signs): open hands 13–59°, pinches
 * 115–143°, fists 157° and more (95% of them).
 */
function indexFlex(lm: Landmark[], aspect: number): number {
  const deg = (u: [number, number, number], v: [number, number, number]) => (Math.acos(Math.max(-1, Math.min(1, cosAngle(u, v)))) * 180) / Math.PI;
  const [w, mcp, pip, dip, tip] = [lm[0], lm[5], lm[6], lm[7], lm[8]];
  return deg(sub(mcp, w, aspect), sub(pip, mcp, aspect)) + deg(sub(pip, mcp, aspect), sub(dip, pip, aspect)) + deg(sub(dip, pip, aspect), sub(tip, dip, aspect));
}

/** Bent less than this, an index finger whose tip meets the thumb is pinching, not curled into a fist. */
const FIST_FLEX = 150;

/**
 * Whether the hand is shaped like a pinch rather than a fist: the index half
 * bent, and the thumb out at its tip rather than resting on the middle
 * finger, where a fist keeps it (thumb to middle knuckle: fists mostly under
 * 0.4 hand sizes, pinches 0.75 and more).
 */
export function pinchShaped(f: Pick<HandFeatures, 'indexFlex' | 'thumbMiddle'>): boolean {
  return f.indexFlex < FIST_FLEX && f.thumbMiddle > 0.4;
}

interface HandFeatures {
  /** Extension of index, middle, ring, pinky (0 curled … 1 straight). */
  fingers: [number, number, number, number];
  /** Total bend of the index finger in degrees (see indexFlex). */
  indexFlex: number;
  /** Thumb tip distance from the middle finger's middle knuckle, relative to hand size. Small in a fist. */
  thumbMiddle: number;
  /** Thumb tip distance from the index knuckle, relative to hand size. Large when the thumb sticks out. */
  thumbOut: number;
  /** Unit direction of the thumb (knuckle → tip) in camera space, y down. */
  thumbDir: { x: number; y: number };
  /** Thumb–index tip distance relative to hand size. Small when pinching. */
  pinch: number;
  scale: number;
}

export function features(lm: Landmark[], aspect: number): HandFeatures {
  const scale = handScale(lm, aspect);
  const fingers = FINGERS.map((f) => fingerExtension(lm, f, aspect)) as [number, number, number, number];
  const tx = (lm[4].x - lm[2].x) * aspect;
  const ty = lm[4].y - lm[2].y;
  const tl = Math.hypot(tx, ty) || 1;
  return {
    fingers,
    indexFlex: indexFlex(lm, aspect),
    thumbMiddle: dist(lm[4], lm[10], aspect) / scale,
    thumbOut: dist(lm[4], lm[5], aspect) / scale,
    thumbDir: { x: tx / tl, y: ty / tl },
    pinch: dist(lm[4], lm[8], aspect) / scale,
    scale,
  };
}

export type Pose = 'point' | 'open' | 'fist' | 'thumbUp' | 'thumbDown' | 'victory' | 'other';

const EXT = 0.62;
const CURL = 0.42;

/** Single-frame pose guess. Temporal smoothing happens in the gesture engine. */
export function classify(f: HandFeatures): Pose {
  const [i, m, r, p] = f.fingers;
  const curled = (v: number) => v < CURL;
  const ext = (v: number) => v > EXT;
  const fourCurled = curled(i) && curled(m) && curled(r) && curled(p);
  const thumbOut = f.thumbOut > 0.5;
  // The thumb on the tip of a half-bent index finger is a pinch, whatever the other fingers do. Pinching
  // from a pointing hand curls the index too, and the thumb rising to meet it can look like a thumbs-up.
  const pinching = f.pinch < 0.45 && pinchShaped(f);

  if (!pinching && fourCurled && thumbOut && f.thumbDir.y < -0.7) return 'thumbUp';
  if (!pinching && fourCurled && thumbOut && f.thumbDir.y > 0.7) return 'thumbDown';
  if (ext(i) && ext(m) && ext(r) && ext(p)) return 'open';
  if (ext(i) && ext(m) && curled(r) && curled(p)) return 'victory';
  if (ext(i) && curled(m) && curled(r)) return 'point';
  // A fist bends the index all the way; half bent, the hand is on its way to a pinch (or back from one).
  if (fourCurled && !pinching && f.indexFlex >= FIST_FLEX) return 'fist';
  return 'other';
}
