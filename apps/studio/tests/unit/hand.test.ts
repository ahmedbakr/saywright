import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE, GestureEngine, type DetectedHand, type HandEvent } from '../../src/core/hand/engine';
import { OneEuro } from '../../src/core/hand/filters';
import { classify, features, pinchShaped, type Landmark } from '../../src/core/hand/geometry';
import { blockUsageLog } from '../../src/core/hand/usage-log';

const here = path.dirname(fileURLToPath(import.meta.url));
type Fixture = { w: number; h: number; hands: { handedness: 'Left' | 'Right'; lm: number[][] }[] };
const FIX: Record<string, Fixture> = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/hands.json'), 'utf8'));
const toLm = (a: number[][]): Landmark[] => a.map(([x, y, z]) => ({ x, y, z }));
/** Real photos through the same model (see `about` in the file): 109 fists, open hands, pinches, pinches from a pointing hand. */
type Shot = { w: number; h: number; lm: number[][] };
const REAL: { fists: Shot[]; open: Shot[]; pinches: Shot[]; pointingPinches: (Shot & { from: string })[] } = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/hands-real.json'), 'utf8'));
const real = (x: Shot): DetectedHand => ({ landmarks: toLm(x.lm), handedness: 'Right', score: 0.99 });
const hand = (name: string, i = 0): DetectedHand => ({ landmarks: toLm(FIX[name].hands[i].lm), handedness: FIX[name].hands[i].handedness, score: 0.99 });
const aspect = (name: string) => FIX[name].w / FIX[name].h;

/** Move every landmark (simulates the whole hand moving in front of the camera). */
const shift = (h: DetectedHand, dx: number, dy: number): DetectedHand => ({ ...h, landmarks: h.landmarks.map((p) => ({ x: p.x + dx, y: p.y + dy, z: p.z })) });
/** Bring the thumb tip onto the index tip: a pinch. */
const pinched = (h: DetectedHand): DetectedHand => {
  const lm = h.landmarks.map((p) => ({ ...p }));
  lm[4] = { x: lm[8].x + 0.004, y: lm[8].y + 0.006, z: lm[8].z };
  lm[3] = { x: (lm[2].x + lm[4].x) / 2, y: (lm[2].y + lm[4].y) / 2, z: lm[4].z };
  return { ...h, landmarks: lm };
};

function engine() {
  return new GestureEngine({ ...DEFAULT_ENGINE }, () => ({ w: 1440, h: 900 }));
}

/** Feed `ms` of frames at 30 fps; returns all events. */
function feed(e: GestureEngine, make: (i: number) => DetectedHand[], ms: number, start: number, asp = 1): { events: HandEvent[]; end: number } {
  const events: HandEvent[] = [];
  let t = start;
  for (let i = 0; t < start + ms; i++, t += 33) events.push(...e.update({ t, hands: make(i), aspect: asp }));
  return { events, end: t };
}

describe('pose classification on real MediaPipe landmarks', () => {
  const expected: [string, number, string][] = [
    ['fist', 0, 'fist'],
    ['pointing_up', 0, 'point'],
    ['pointing_up_rotated', 0, 'point'],
    ['thumbs_up', 0, 'thumbUp'],
    ['thumbs_down', 0, 'thumbDown'],
    ['victory', 0, 'victory'],
    ['x_left_hands', 0, 'open'],
    ['x_left_hands', 1, 'open'],
    ['x_right_hands', 0, 'open'],
    ['x_right_hands', 1, 'open'],
  ];
  it.each(expected)('%s #%i is %s', (name, i, pose) => {
    expect(classify(features(toLm(FIX[name].hands[i].lm), aspect(name)))).toBe(pose);
  });

  it('a fist is not a pinch even though the thumb touches the index finger', () => {
    const e = engine();
    const { events } = feed(e, () => [hand('fist')], 600, 0, aspect('fist'));
    expect(events.map((x) => x.type)).not.toContain('pinchStart');
    expect(events).toContainEqual({ type: 'clutch', on: true });
  });
});

describe('gesture engine', () => {
  const A = aspect('pointing_up');

  it('follows the index fingertip, mirrored like a mirror', () => {
    const e = engine();
    feed(e, () => [hand('pointing_up')], 400, 0, A);
    const x1 = e.state.x;
    feed(e, () => [shift(hand('pointing_up'), -0.08, 0)], 600, 400, A); // hand moves left in the image = right for the user
    expect(e.state.x).toBeGreaterThan(x1 + 80);
    expect(e.state.present).toBe(true);
  });

  it('a quick pinch taps where the cursor was before the fingers closed', () => {
    const e = engine();
    const r1 = feed(e, () => [hand('pointing_up')], 500, 0, A);
    const before = { x: e.state.x, y: e.state.y };
    const r2 = feed(e, () => [pinched(hand('pointing_up'))], 200, r1.end, A);
    const r3 = feed(e, () => [hand('pointing_up')], 200, r2.end, A);
    const all = [...r1.events, ...r2.events, ...r3.events];
    const tap = all.find((x) => x.type === 'tap') as Extract<HandEvent, { type: 'tap' }>;
    expect(tap).toBeTruthy();
    expect(Math.abs(tap.x - before.x)).toBeLessThan(6);
    expect(Math.abs(tap.y - before.y)).toBeLessThan(6);
    expect(all.map((x) => x.type)).not.toContain('dragStart');
  });

  it('pinch and move drags, then releases', () => {
    const e = engine();
    const r1 = feed(e, () => [hand('pointing_up')], 400, 0, A);
    const r2 = feed(e, (i) => [shift(pinched(hand('pointing_up')), -Math.min(i, 12) * 0.008, 0)], 700, r1.end, A);
    const r3 = feed(e, () => [hand('pointing_up')], 200, r2.end, A);
    const types = [...r2.events, ...r3.events].map((x) => x.type);
    expect(types).toContain('dragStart');
    expect(types).toContain('drag');
    expect(types).toContain('dragEnd');
    expect(types).not.toContain('tap');
  });

  it('thumbs up held briefly fires exactly once', () => {
    const e = engine();
    const { events } = feed(e, () => [hand('thumbs_up')], 1200, 0, aspect('thumbs_up'));
    expect(events.filter((x) => x.type === 'thumbUp')).toHaveLength(1);
  });

  it('thumbs down fires thumbDown', () => {
    const e = engine();
    const { events } = feed(e, () => [hand('thumbs_down')], 900, 0, aspect('thumbs_down'));
    expect(events.filter((x) => x.type === 'thumbDown')).toHaveLength(1);
  });

  it('a peace sign held briefly starts talking, once', () => {
    const e = engine();
    const { events } = feed(e, () => [hand('victory')], 1000, 0, aspect('victory'));
    expect(events.filter((x) => x.type === 'victory')).toHaveLength(1);
    expect(events.map((x) => x.type)).not.toContain('pinchStart');
  });

  it('an open palm held still stops; a waving one does not', () => {
    const still = engine();
    const a = feed(still, () => [hand('x_right_hands', 1)], 1200, 0, aspect('x_right_hands'));
    expect(a.events.filter((x) => x.type === 'palm')).toHaveLength(1);
    const waving = engine();
    const b = feed(waving, (i) => [shift(hand('x_right_hands', 1), Math.sin(i / 1.5) * 0.06, 0)], 1500, 0, aspect('x_right_hands'));
    expect(b.events.filter((x) => x.type === 'palm')).toHaveLength(0);
  });

  it('reports the hand as lost after a short gap', () => {
    const e = engine();
    const r1 = feed(e, () => [hand('pointing_up')], 200, 0, A);
    const r2 = feed(e, () => [], 400, r1.end, A);
    expect(r1.events[0]).toEqual({ type: 'found' });
    expect(r2.events.map((x) => x.type)).toContain('lost');
    expect(e.state.present).toBe(false);
  });

  it('prefers the chosen hand when two are visible', () => {
    const e = engine();
    e.configure({ hand: 'left' });
    feed(e, () => [hand('woman_hands', 0), hand('woman_hands', 1)], 200, 0, aspect('woman_hands'));
    expect(e.state.hand).toBe('left');
    const r = engine();
    r.configure({ hand: 'right' });
    feed(r, () => [hand('woman_hands', 0), hand('woman_hands', 1)], 200, 0, aspect('woman_hands'));
    expect(r.state.hand).toBe('right');
  });
});

describe('pinching on real hands', () => {
  const A = aspect('pointing_up');
  /** The pointing hand moving, landmark by landmark, into another hand shape over `ms` (a gesture takes ~200 ms). */
  const between = (a: DetectedHand, b: DetectedHand, k: number): DetectedHand => ({ ...a, landmarks: a.landmarks.map((p, i) => ({ x: p.x + (b.landmarks[i].x - p.x) * k, y: p.y + (b.landmarks[i].y - p.y) * k, z: p.z + (b.landmarks[i].z - p.z) * k })) });
  /** Point, pinch (moving into it over 200 ms), hold, let go. */
  function pinchFrom(pinch: DetectedHand, holdMs = 200) {
    const e = engine();
    const point = hand('pointing_up');
    const r1 = feed(e, () => [point], 600, 0, A);
    const aimed = { x: e.state.x, y: e.state.y };
    const r2 = feed(e, (i) => [between(point, pinch, Math.min(1, (i + 1) / 6))], 200 + holdMs, r1.end, A);
    const r3 = feed(e, (i) => [between(pinch, point, Math.min(1, (i + 1) / 6))], 400, r2.end, A);
    return { e, aimed, events: [...r1.events, ...r2.events, ...r3.events] };
  }

  it('recognises the shape: real pinches, and pinches made from a pointing hand, but no held fist', () => {
    for (const x of [...REAL.pinches, ...REAL.pointingPinches]) expect(pinchShaped(features(toLm(x.lm), x.w / x.h))).toBe(true);
    // Pinching from a pointing hand curls the index too: it isn't a fist, or a thumbs-up.
    for (const x of REAL.pointingPinches) expect(classify(features(toLm(x.lm), x.w / x.h))).toBe('other');
    const fistLike = REAL.fists.filter((x) => {
      const f = features(toLm(x.lm), x.w / x.h);
      return pinchShaped(f) && f.pinch < DEFAULT_ENGINE.pinchOn;
    });
    expect(fistLike.length).toBeLessThanOrEqual(1); // of 109, photographed from awkward angles
  });

  it.each(REAL.pointingPinches.map((x) => [x.from, x] as const))('a pinch from a pointing hand (thumb and index as in %s) taps once, where the finger pointed', (_name, x) => {
    const { aimed, events } = pinchFrom(real(x));
    const taps = events.filter((x) => x.type === 'tap') as Extract<HandEvent, { type: 'tap' }>[];
    expect(taps).toHaveLength(1);
    expect(events.map((x) => x.type)).not.toContain('clutch');
    // The fingertip moves a long way while the index bends onto the thumb; the click doesn't.
    expect(Math.hypot(taps[0].x - aimed.x, taps[0].y - aimed.y)).toBeLessThan(12);
  });

  it.each([
    ['the index bends first, then the thumb comes up', [6, 7, 8], [1, 2, 3, 4]],
    ['the thumb comes up first, then the index bends', [1, 2, 3, 4], [6, 7, 8]],
  ] as const)('the click lands where the finger pointed when %s', (_how, first, second) => {
    // One part of the hand moves at a time (a real pinch is rarely one smooth motion). Before this engine held the
    // fingertip's offset, the index-first order clicked up to 130 px away, after freezing the cursor as a "fist".
    const part = (a: DetectedHand, b: DetectedHand, k: number, idx: readonly number[]): DetectedHand => ({ ...a, landmarks: a.landmarks.map((p, i) => (idx.includes(i) ? { x: p.x + (b.landmarks[i].x - p.x) * k, y: p.y + (b.landmarks[i].y - p.y) * k, z: p.z + (b.landmarks[i].z - p.z) * k } : p)) });
    for (const x of REAL.pointingPinches) {
      const e = engine();
      const point = hand('pointing_up');
      const pinch = real(x);
      const r1 = feed(e, () => [point], 600, 0, A);
      const aimed = { x: e.state.x, y: e.state.y };
      const r2 = feed(e, (i) => [part(point, pinch, Math.min(1, (i + 1) / 6), first)], 200, r1.end, A);
      const mid = part(point, pinch, 1, first);
      const r3 = feed(e, (i) => [part(mid, pinch, Math.min(1, (i + 1) / 6), second)], 400, r2.end, A);
      const r4 = feed(e, (i) => [part(pinch, point, Math.min(1, (i + 1) / 8), [1, 2, 3, 4, 6, 7, 8])], 400, r3.end, A);
      const events = [...r1.events, ...r2.events, ...r3.events, ...r4.events];
      const taps = events.filter((x) => x.type === 'tap') as Extract<HandEvent, { type: 'tap' }>[];
      expect(taps).toHaveLength(1);
      expect(Math.hypot(taps[0].x - aimed.x, taps[0].y - aimed.y)).toBeLessThan(5);
      expect(events.map((x) => x.type)).not.toContain('clutch');
    }
  });

  it('the fingertip really does move that far while pinching (so holding the aim matters)', () => {
    const e = engine();
    const point = e.toScreen(hand('pointing_up').landmarks[8]);
    const moved = REAL.pointingPinches.map((x) => {
      const tip = e.toScreen(toLm(x.lm)[8]);
      return Math.hypot(tip.x - point.x, tip.y - point.y);
    });
    expect(Math.min(...moved)).toBeGreaterThan(60);
  });

  it('holding the pinch still is a hold, once, while the fingers are together and where the finger pointed', () => {
    const { aimed, events } = pinchFrom(real(REAL.pointingPinches[1]), 1400);
    const holds = events.filter((x) => x.type === 'hold') as Extract<HandEvent, { type: 'hold' }>[];
    expect(holds).toHaveLength(1);
    expect(Math.hypot(holds[0].x - aimed.x, holds[0].y - aimed.y)).toBeLessThan(12);
    // Letting go afterwards is the end of that hold, not a second action of its own.
    const types = events.map((x) => x.type);
    expect(types.indexOf('hold')).toBeLessThan(types.indexOf('tap'));
    expect((events.find((x) => x.type === 'tap') as Extract<HandEvent, { type: 'tap' }>).held).toBe(true);
  });

  it('a quick pinch is not a hold', () => {
    const { events } = pinchFrom(real(REAL.pointingPinches[1]), 150);
    expect(events.map((x) => x.type)).not.toContain('hold');
    expect((events.find((x) => x.type === 'tap') as Extract<HandEvent, { type: 'tap' }>).held).toBe(false);
  });

  it('the hold shows its progress while the fingers are together, then is done', () => {
    const e = engine();
    const point = hand('pointing_up');
    const pinch = real(REAL.pointingPinches[1]);
    const r1 = feed(e, () => [point], 600, 0, A);
    const seen: number[] = [];
    let t = r1.end;
    for (let i = 0; i < 30; i++, t += 33) {
      e.update({ t, hands: [between(point, pinch, Math.min(1, (i + 1) / 6))], aspect: A });
      if (e.state.pinching) seen.push(e.state.pinchHold);
    }
    expect(seen[0]).toBe(0); // a quick tap never shows it
    expect(seen.some((v) => v > 0.3 && v < 0.9)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('a hand that drifts while pinching still taps: scrolling needs a deliberate move', () => {
    // About 1.5 cm of wander, back and forth and a little to one side: what a real hand does while pinching.
    // A fixed 26 px used to turn this into a scroll, which undid the selection the pinch had just made.
    for (const x of REAL.pointingPinches) {
      const e = engine();
      const point = hand('pointing_up');
      const pinch = real(x);
      const r1 = feed(e, () => [point], 600, 0, A);
      const wander = (i: number) => ({ dx: Math.sin(i / 2) * 0.01 + i * 0.0008, dy: Math.cos(i / 3) * 0.008 });
      const r2 = feed(e, (i) => [shift(between(point, pinch, Math.min(1, (i + 1) / 6)), wander(i).dx, wander(i).dy)], 500, r1.end, A);
      const r3 = feed(e, (i) => [between(pinch, point, Math.min(1, (i + 1) / 6))], 400, r2.end, A);
      const types = [...r2.events, ...r3.events].map((x) => x.type);
      expect(types).not.toContain('dragStart');
      expect(types.filter((x) => x === 'tap')).toHaveLength(1);
    }
  });

  it('a slow, steady move scrolls and is never mistaken for a hold', () => {
    const e = engine();
    const point = hand('pointing_up');
    const pinch = real(REAL.pointingPinches[1]);
    const r1 = feed(e, () => [point], 600, 0, A);
    const r2 = feed(e, (i) => [shift(between(point, pinch, Math.min(1, (i + 1) / 6)), 0, i > 6 ? (i - 6) * 0.003 : 0)], 1500, r1.end, A);
    const types = r2.events.map((x) => x.type);
    expect(types).toContain('dragStart');
    expect(types).not.toContain('hold');
  });

  it('the move that scrolls is a share of the screen, so it takes the same hand movement on any screen', () => {
    const decide = (w: number, h: number, move: number) => {
      const e = new GestureEngine({ ...DEFAULT_ENGINE }, () => ({ w, h }));
      const point = hand('pointing_up');
      const pinch = real(REAL.pointingPinches[1]);
      const r1 = feed(e, () => [point], 600, 0, A);
      const r2 = feed(e, (i) => [shift(between(point, pinch, Math.min(1, (i + 1) / 6)), i > 6 ? Math.min(1, (i - 6) / 6) * move : 0, 0)], 600, r1.end, A);
      return r2.events.some((x) => x.type === 'dragStart');
    };
    for (const [w, h] of [[1280, 720], [1440, 900], [2560, 1440]]) {
      expect(decide(w, h, 0.012)).toBe(false);
      expect(decide(w, h, 0.05)).toBe(true);
    }
  });

  it('no real fist clicks, held or made from a pointing hand', () => {
    let clicks = 0;
    for (const x of REAL.fists) {
      const fist = real(x);
      const asp = x.w / x.h;
      // Held.
      const held = feed(engine(), () => [fist], 800, 0, asp).events;
      // Closed from an open hand within a moment (the fingers were apart just before).
      const e = engine();
      const r1 = feed(e, () => [real(REAL.open[0])], 300, 0, asp);
      const closed = feed(e, () => [fist], 900, r1.end, asp).events;
      clicks += [...held, ...closed].filter((x) => x.type === 'tap' || x.type === 'hold').length;
    }
    expect(clicks).toBeLessThanOrEqual(1);
  });

  it('a pinch that keeps closing into a fist is let go, not clicked', () => {
    const e = engine();
    const point = hand('pointing_up');
    const pinch = real(REAL.pointingPinches[1]);
    // The fist photo's hand, put where the pointing hand is (its index knuckle in the same place, same size).
    const palm = (h: DetectedHand) => ({ x: h.landmarks[5].x, y: h.landmarks[5].y, s: Math.hypot(h.landmarks[9].x - h.landmarks[0].x, h.landmarks[9].y - h.landmarks[0].y) });
    const [from, to] = [palm(hand('fist')), palm(point)];
    const fist: DetectedHand = { ...hand('fist'), landmarks: hand('fist').landmarks.map((p) => ({ x: to.x + ((p.x - from.x) * to.s) / from.s, y: to.y + ((p.y - from.y) * to.s) / from.s, z: (p.z * to.s) / from.s })) };
    const r1 = feed(e, () => [point], 500, 0, A);
    const r2 = feed(e, () => [pinch], 200, r1.end, A);
    const r3 = feed(e, () => [fist], 400, r2.end, A);
    const types = [...r1.events, ...r2.events, ...r3.events].map((x) => x.type);
    expect(types).toContain('pinchStart');
    expect(types).toContain('pinchCancel');
    expect(types).not.toContain('tap');
  });
});

describe('OneEuro', () => {
  it('removes jitter at rest and still tracks a real move', () => {
    const f = new OneEuro(1.0, 0.01);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const out: number[] = [];
    for (let i = 0; i < 90; i++) out.push(f.filter(500 + rnd() * 6, i * 33));
    const tail = out.slice(30);
    const spread = Math.max(...tail) - Math.min(...tail);
    expect(spread).toBeLessThan(5); // raw spread is ~12px
    let v = 0;
    for (let i = 90; i < 120; i++) v = f.filter(800, i * 33);
    expect(v).toBeGreaterThan(790);
  });
});

describe('MediaPipe’s usage log', () => {
  it('is blocked where the hand tracker runs, and nothing else is', async () => {
    const sent: string[] = [];
    const scope = { fetch: (async (input: RequestInfo | URL) => (sent.push(String(input)), new Response('ok'))) as typeof fetch };
    const own = scope.fetch;
    const unblock = blockUsageLog(scope);
    await expect(scope.fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST', body: 'usage' })).rejects.toThrow(TypeError);
    await expect(scope.fetch(new Request('https://odml.pa.googleapis.com/v1/log'))).rejects.toThrow(TypeError);
    expect(await (await scope.fetch('https://storage.googleapis.com/mediapipe-models/hand_landmarker.task')).text()).toBe('ok');
    expect(sent).toEqual(['https://storage.googleapis.com/mediapipe-models/hand_landmarker.task']);
    unblock();
    expect(scope.fetch).toBe(own);
  });
});
