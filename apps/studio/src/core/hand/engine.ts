/**
 * Turns per-frame hand landmarks into a steady cursor and discrete gestures.
 *
 * Design choices that make hand control feel good:
 * - A pinch is the thumb meeting the tip of a half-bent index finger, however
 *   the other fingers are held: pinching from a pointing hand curls the index,
 *   which a pose classifier alone would call a fist (measured on real hands).
 * - Click stabilisation: closing a pinch bends the index and drags its tip.
 *   The cursor is the index knuckle plus the fingertip's offset from it, and
 *   that offset stays as it was while the fingers close, so the cursor doesn't
 *   move and the click lands on what was highlighted.
 * - Drag uses the index knuckle, which barely moves while the finger curls.
 * - Hysteresis everywhere: a pinch starts below one threshold and ends above a
 *   higher one, and only after the fingers were apart; poses must persist
 *   before they count.
 * - Holds (open palm, thumbs) fire once, only while the hand is still.
 * - A pinch is one of three things, never two: a tap (released quickly), a
 *   hold (kept still for a moment), or a scroll (the hand clearly moves, by a
 *   share of the screen rather than a few pixels, so a hand that drifts while
 *   pinching still taps).
 */
import { OneEuro2D, smoothingParams } from './filters';
import { classify, features, pinchShaped, type Landmark, type Pose } from './geometry';

export interface DetectedHand {
  landmarks: Landmark[];
  /** MediaPipe's label for an un-mirrored frame (it assumes a mirrored one, so it is swapped). */
  handedness: 'Left' | 'Right';
  score: number;
}

export interface HandFrame {
  t: number;
  hands: DetectedHand[];
  /** Camera frame width / height. */
  aspect: number;
}

interface ActiveBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface EngineSettings {
  hand: 'any' | 'left' | 'right';
  /** Region of the (mirrored) camera frame that maps to the whole screen. */
  box: ActiveBox;
  /** 0 = most responsive, 1 = steadiest. */
  steadiness: number;
  pinchOn: number;
  pinchOff: number;
  palmHoldMs: number;
  thumbHoldMs: number;
  talkHoldMs: number;
  /** How long a still pinch lasts before it counts as a hold. */
  pinchHoldMs: number;
  palmEnabled: boolean;
  thumbsEnabled: boolean;
  /** Peace sign starts listening. */
  talkEnabled: boolean;
}

export const DEFAULT_ENGINE: EngineSettings = {
  hand: 'any',
  box: { x0: 0.18, y0: 0.14, x1: 0.82, y1: 0.74 },
  steadiness: 0.55,
  pinchOn: 0.3,
  pinchOff: 0.44,
  palmHoldMs: 700,
  thumbHoldMs: 380,
  talkHoldMs: 320,
  pinchHoldMs: 650,
  palmEnabled: true,
  thumbsEnabled: true,
  talkEnabled: true,
};

export type HandEvent =
  | { type: 'found' }
  | { type: 'lost' }
  | { type: 'pinchStart'; x: number; y: number }
  /** The pinch was kept still for `pinchHoldMs`: fired while the fingers are still together. */
  | { type: 'hold'; x: number; y: number }
  /** The fingers opened again without scrolling. `held`: a hold fired first. */
  | { type: 'tap'; x: number; y: number; held: boolean }
  | { type: 'dragStart'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; dx: number; dy: number }
  | { type: 'dragEnd'; x: number; y: number }
  | { type: 'pinchCancel' }
  | { type: 'palm' }
  | { type: 'thumbUp' }
  | { type: 'thumbDown' }
  | { type: 'victory' }
  | { type: 'clutch'; on: boolean };

export type HoldKind = 'palm' | 'thumbUp' | 'thumbDown' | 'victory';

interface PointerState {
  present: boolean;
  x: number;
  y: number;
  pose: Pose | 'pinch';
  /** 0 when the fingers are apart, 1 at the pinch threshold: drives the cursor's "about to click" look. */
  pinchAmount: number;
  pinching: boolean;
  /** While a still pinch counts towards a hold: 0 → 1 (1 once it fired). */
  pinchHold: number;
  dragging: boolean;
  holdKind: HoldKind | null;
  holdProgress: number;
  clutched: boolean;
  hand: 'left' | 'right' | null;
  /** Raw landmarks of the active hand (camera space), for drawing. */
  landmarks: Landmark[] | null;
  lastSeen: number;
}

const LOST_AFTER_MS = 260;
const POSE_STABLE_MS = 110;
const STILL_PX_PER_S = 900;
/** A pinch becomes a scroll once the knuckle moved this share of the screen's diagonal (about 2–3 cm of hand). */
const SCROLL_SHARE = 0.045;
/** A pinch that moved more than this share of the scroll distance is on its way to a scroll: it won't count as a hold. */
const HOLD_STILL_SHARE = 0.5;
/** The hold ring shows only after this long, so quick taps don't flash it. */
const HOLD_SHOW_MS = 180;
/** Thumb–index distance (in hand sizes) the fingers must have been apart by, recently, for a pinch to start. */
const OPEN_DISTANCE = 0.6;
const OPEN_WITHIN_MS = 1200;
/** The fingers are closing once their distance drops this far below its recent peak: from then the fingertip's offset is held. */
const CLOSING_DROP = 0.07;

export class GestureEngine {
  readonly state: PointerState = {
    present: false,
    x: 0,
    y: 0,
    pose: 'other',
    pinchAmount: 0,
    pinching: false,
    pinchHold: 0,
    dragging: false,
    holdKind: null,
    holdProgress: 0,
    clutched: false,
    hand: null,
    landmarks: null,
    lastSeen: 0,
  };

  private filter: OneEuro2D;
  private history: { t: number; x: number; y: number }[] = [];
  /** Recent thumb–index distances and fingertip offsets from the knuckle (screen px), to hold the aim while a pinch closes. */
  private fingers: { t: number; d: number; ox: number; oy: number }[] = [];
  /** The fingertip offset held since the fingers started closing, the distance at which they were seen closing, and when. */
  private held: { ox: number; oy: number; at: number; since: number } | null = null;
  private lastOpen = -Infinity;
  private lastWrist: { x: number; y: number } | null = null;
  private candidate: { pose: Pose; since: number } = { pose: 'other', since: 0 };
  private stablePose: Pose = 'other';
  private poseSince = 0;
  private holdFired = false;
  private pinchFrames = 0;
  private releaseFrames = 0;
  private pinch: { t: number; anchorX: number; anchorY: number; kx: number; ky: number; offX: number; offY: number; moved: number; held: boolean } | null = null;
  private prevCursor: { t: number; x: number; y: number } | null = null;
  private speed = 0;

  constructor(
    public settings: EngineSettings,
    private viewport: () => { w: number; h: number },
  ) {
    const p = smoothingParams(settings.steadiness);
    this.filter = new OneEuro2D(p.minCutoff, p.beta);
  }

  configure(settings: Partial<EngineSettings>): void {
    this.settings = { ...this.settings, ...settings };
    const p = smoothingParams(this.settings.steadiness);
    this.filter.set(p.minCutoff, p.beta);
  }

  /** Map a camera-space point (un-mirrored) to viewport pixels through the active box. */
  toScreen(p: { x: number; y: number }): { x: number; y: number } {
    const { w, h } = this.viewport();
    const b = this.settings.box;
    const mx = 1 - p.x; // mirror, so moving your hand right moves the cursor right
    const nx = (mx - b.x0) / Math.max(0.05, b.x1 - b.x0);
    const ny = (p.y - b.y0) / Math.max(0.05, b.y1 - b.y0);
    return { x: Math.max(0, Math.min(w, nx * w)), y: Math.max(0, Math.min(h, ny * h)) };
  }

  private pickHand(hands: DetectedHand[]): DetectedHand | null {
    if (!hands.length) return null;
    const userHand = (h: DetectedHand) => (h.handedness === 'Left' ? 'right' : 'left');
    let pool = hands;
    if (this.settings.hand !== 'any') {
      const preferred = hands.filter((h) => userHand(h) === this.settings.hand);
      if (preferred.length) pool = preferred;
    }
    if (this.lastWrist) {
      let best: DetectedHand | null = null;
      let bd = Infinity;
      for (const h of pool) {
        const d = Math.hypot(h.landmarks[0].x - this.lastWrist.x, h.landmarks[0].y - this.lastWrist.y);
        if (d < bd) {
          bd = d;
          best = h;
        }
      }
      if (best && bd < 0.25) return best;
    }
    // Otherwise the raised hand: the one whose index fingertip is highest.
    return pool.reduce((a, b) => (b.landmarks[8].y < a.landmarks[8].y ? b : a));
  }

  private holdKindFor(pose: Pose): HoldKind | null {
    const st = this.settings;
    if (pose === 'open') return st.palmEnabled ? 'palm' : null;
    if (pose === 'thumbUp' || pose === 'thumbDown') return st.thumbsEnabled ? pose : null;
    if (pose === 'victory') return st.talkEnabled ? 'victory' : null;
    return null;
  }

  private lookback(at: number): { x: number; y: number } | null {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].t <= at) return this.history[i];
    return null;
  }

  /**
   * Aim while pinching: the knuckle barely moves as the index bends, the fingertip does. From the moment the
   * fingers start closing, the fingertip's offset from the knuckle is held at what it was before.
   */
  private aim(t: number, d: number, tip: { x: number; y: number }, knuckle: { x: number; y: number }): { x: number; y: number } {
    const ox = tip.x - knuckle.x;
    const oy = tip.y - knuckle.y;
    const before = this.fingers.find((f) => f.t >= t - 120);
    this.fingers.push({ t, d, ox, oy });
    while (this.fingers.length && this.fingers[0].t < t - 700) this.fingers.shift();
    if (!this.held) {
      let peak = this.fingers[0];
      for (const f of this.fingers) if (f.d >= peak.d) peak = f;
      if (d < peak.d - CLOSING_DROP && d < 0.95) this.held = { ox: peak.ox, oy: peak.oy, at: d, since: t };
    } else if (!this.state.pinching) {
      // Open again (a pinch released, or one that never closed): back to the fingertip once the fingers are
      // apart and no longer closing.
      const closing = !!before && d < before.d - 0.01;
      if (d > this.held.at + 0.02 || (d >= OPEN_DISTANCE && !closing && t - this.held.since > 250)) this.held = null;
    }
    const o = this.held ?? { ox, oy };
    return { x: knuckle.x + o.ox, y: knuckle.y + o.oy };
  }

  /** Knuckle travel (px) that turns a pinch into a scroll. */
  scrollDistance(): number {
    const { w, h } = this.viewport();
    return Math.max(40, SCROLL_SHARE * Math.hypot(w, h));
  }

  private endPinch(events: HandEvent[], cancelled: boolean): void {
    const p = this.pinch;
    if (!p) return;
    if (cancelled) events.push(this.state.dragging ? { type: 'dragEnd', x: this.state.x, y: this.state.y } : { type: 'pinchCancel' });
    else if (this.state.dragging) events.push({ type: 'dragEnd', x: this.state.x, y: this.state.y });
    else events.push({ type: 'tap', x: p.anchorX, y: p.anchorY, held: p.held });
    this.pinch = null;
    this.state.pinching = false;
    this.state.pinchHold = 0;
    this.state.dragging = false;
  }

  update(frame: HandFrame): HandEvent[] {
    const events: HandEvent[] = [];
    const s = this.state;
    const t = frame.t;
    const hand = this.pickHand(frame.hands);

    if (!hand) {
      if (s.present && t - s.lastSeen > LOST_AFTER_MS) {
        this.endPinch(events, true);
        s.present = false;
        s.landmarks = null;
        s.holdKind = null;
        s.holdProgress = 0;
        if (s.clutched) {
          s.clutched = false;
          events.push({ type: 'clutch', on: false });
        }
        this.lastWrist = null;
        this.history = [];
        this.fingers = [];
        this.held = null;
        this.filter.reset();
        this.prevCursor = null;
        events.push({ type: 'lost' });
      }
      return events;
    }

    const lm = hand.landmarks;
    const f = features(lm, frame.aspect);
    const raw = classify(f);
    const wasPresent = s.present;
    s.present = true;
    s.lastSeen = t;
    s.landmarks = lm;
    s.hand = hand.handedness === 'Left' ? 'right' : 'left';
    this.lastWrist = { x: lm[0].x, y: lm[0].y };
    if (!wasPresent) events.push({ type: 'found' });

    // Pose with a short persistence requirement.
    if (raw !== this.candidate.pose) this.candidate = { pose: raw, since: t };
    if (this.candidate.pose !== this.stablePose && t - this.candidate.since >= POSE_STABLE_MS) {
      this.stablePose = this.candidate.pose;
      this.poseSince = t;
      this.holdFired = false;
      // Curling the fingers into a fist or thumbs gesture drags the fingertip; put the
      // cursor back where it was pointing just before the hand changed shape.
      if (this.stablePose === 'fist' || this.stablePose === 'thumbUp' || this.stablePose === 'thumbDown') {
        const before = this.lookback(t - POSE_STABLE_MS - 60);
        if (before) {
          s.x = before.x;
          s.y = before.y;
        }
      }
    }

    // Pinch with hysteresis. A fist also brings the thumb onto the index finger: it bends the index much
    // further, and it isn't a pinch. Nor is a hand that was already closed (a pinch starts from apart).
    const canPinch = pinchShaped(f);
    const { pinchOn, pinchOff } = this.settings;
    if (f.pinch >= OPEN_DISTANCE) this.lastOpen = t;
    const opened = t - this.lastOpen <= OPEN_WITHIN_MS;
    if (!s.pinching) {
      this.pinchFrames = canPinch && opened && f.pinch < pinchOn ? this.pinchFrames + 1 : 0;
    } else {
      this.releaseFrames = f.pinch > pinchOff || !canPinch ? this.releaseFrames + 1 : 0;
    }
    const far = pinchOff * 1.9;
    s.pinchAmount = Math.max(0, Math.min(1, (far - f.pinch) / (far - pinchOn)));

    // Cursor target: the index fingertip (held still while a pinch closes), or the knuckle plus an offset while dragging.
    const knuckle = this.toScreen(lm[5]);
    const tip = this.aim(t, f.pinch, this.toScreen(lm[8]), knuckle);
    const clutch = this.stablePose === 'fist' && !s.pinching;
    // The cursor keeps following an open hand (many people point that way); thumbs freeze it.
    const holding = !s.pinching && (this.stablePose === 'thumbUp' || this.stablePose === 'thumbDown');

    if (clutch !== s.clutched) {
      s.clutched = clutch;
      events.push({ type: 'clutch', on: clutch });
    }

    if (!s.pinching && this.pinchFrames >= 2) {
      // Where the cursor is: the fingertip's offset has been held since the fingers started closing.
      const a = { x: s.x, y: s.y };
      this.pinch = { t, anchorX: a.x, anchorY: a.y, kx: knuckle.x, ky: knuckle.y, offX: 0, offY: 0, moved: 0, held: false };
      s.pinching = true;
      this.releaseFrames = 0;
      events.push({ type: 'pinchStart', x: a.x, y: a.y });
    } else if (s.pinching && this.releaseFrames >= 2) {
      // Closing into a fist isn't a click.
      this.endPinch(events, !canPinch && f.pinch <= pinchOff);
      this.pinchFrames = 0;
      this.filter.reset(); // resume from the fingertip without dragging the old anchor along
    }

    if (s.pinching && this.pinch) {
      const p = this.pinch;
      const scroll = this.scrollDistance();
      p.moved = Math.max(p.moved, Math.hypot(knuckle.x - p.kx, knuckle.y - p.ky));
      if (!s.dragging && p.moved > scroll) {
        s.dragging = true;
        s.pinchHold = 0;
        p.offX = p.anchorX - p.kx;
        p.offY = p.anchorY - p.ky;
        events.push({ type: 'dragStart', x: p.anchorX, y: p.anchorY });
      }
      // Kept still: a hold, once, while the fingers are still together.
      if (!s.dragging && !p.held) {
        const still = p.moved <= scroll * HOLD_STILL_SHARE;
        const need = this.settings.pinchHoldMs;
        s.pinchHold = still ? Math.max(0, Math.min(1, (t - p.t - HOLD_SHOW_MS) / Math.max(1, need - HOLD_SHOW_MS))) : 0;
        if (still && t - p.t >= need) {
          p.held = true;
          s.pinchHold = 1;
          events.push({ type: 'hold', x: p.anchorX, y: p.anchorY });
        }
      }
      if (s.dragging) {
        const target = this.filter.filter(knuckle.x + p.offX, knuckle.y + p.offY, t);
        const dx = target.x - s.x;
        const dy = target.y - s.y;
        s.x = target.x;
        s.y = target.y;
        if (dx || dy) events.push({ type: 'drag', x: s.x, y: s.y, dx, dy });
      } else {
        // Hold still at the anchor until the hand clearly moves.
        this.filter.filter(p.anchorX, p.anchorY, t);
      }
    } else if (!clutch && !holding) {
      const sm = this.filter.filter(tip.x, tip.y, t);
      s.x = sm.x;
      s.y = sm.y;
    }

    // Speed, for "hold still" gestures.
    if (this.prevCursor) {
      const dt = Math.max(1, t - this.prevCursor.t) / 1000;
      const inst = Math.hypot(tip.x - this.prevCursor.x, tip.y - this.prevCursor.y) / dt;
      this.speed = this.speed * 0.7 + inst * 0.3;
    }
    this.prevCursor = { t, x: tip.x, y: tip.y };

    this.history.push({ t, x: s.x, y: s.y });
    while (this.history.length && this.history[0].t < t - 400) this.history.shift();

    // Holds: open palm stops everything, thumbs keep or discard, a peace sign starts listening.
    const kind = s.pinching ? null : this.holdKindFor(this.stablePose);
    if (kind && this.speed > STILL_PX_PER_S && !this.holdFired) this.poseSince = t; // moving: restart the hold
    s.holdKind = kind;
    if (kind) {
      const need = kind === 'palm' ? this.settings.palmHoldMs : kind === 'victory' ? this.settings.talkHoldMs : this.settings.thumbHoldMs;
      s.holdProgress = this.holdFired ? 1 : Math.min(1, (t - this.poseSince) / need);
      if (!this.holdFired && s.holdProgress >= 1) {
        this.holdFired = true;
        events.push({ type: kind });
      }
    } else {
      s.holdProgress = 0;
    }

    s.pose = s.pinching ? 'pinch' : this.stablePose;
    return events;
  }
}
