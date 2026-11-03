/**
 * Fusion of speech and pointing. Every "this" or "that" is bound to the element
 * the user was pointing at while saying it, compensating for speech
 * recognition latency, unless they pinned things first (pins win, in order).
 */
import { ARABIC_DEICTIC } from '@shared/arabic-commands';
import { foldArabic } from '@shared/text-compare';
import type { ElementInfo } from '@saywright/vite/protocol';
import type { Word } from './voice/speech';

interface TrackSample {
  t: number;
  el: ElementInfo | null;
}

export class PointerTrack {
  private samples: TrackSample[] = [];

  push(t: number, el: ElementInfo | null): void {
    const last = this.samples[this.samples.length - 1];
    if (last && last.t >= t) return;
    this.samples.push({ t, el });
    const cutoff = t - 20_000;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  clear(): void {
    this.samples = [];
  }

  /** What was under the pointer at time t. */
  at(t: number): ElementInfo | null {
    for (let i = this.samples.length - 1; i >= 0; i--) if (this.samples[i].t <= t) return this.samples[i].el;
    return null;
  }

  /** The element pointed at longest within [t0, t1]. */
  dwellWinner(t0: number, t1: number): ElementInfo | null {
    const totals = new Map<number, { el: ElementInfo; ms: number }>();
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const end = i + 1 < this.samples.length ? this.samples[i + 1].t : t1;
      const a = Math.max(s.t, t0);
      const b = Math.min(end, t1);
      if (b <= a || !s.el) continue;
      const cur = totals.get(s.el.id) ?? { el: s.el, ms: 0 };
      cur.ms += b - a;
      totals.set(s.el.id, cur);
    }
    let best: { el: ElementInfo; ms: number } | null = null;
    for (const v of totals.values()) if (!best || v.ms > best.ms) best = v;
    return best?.el ?? null;
  }
}

const DEICTIC = /^(this|that|these|those|here|there|it)$/i;
const DISTAL = /^(that|those|there|ذلك|ذاك|تلك|هذاك|هذيك|هناك|هنيك)$/i;

interface ResolvedRef {
  word: string;
  index: number;
  t: number;
  el: ElementInfo | null;
  via: 'pin' | 'pointing' | 'selection' | 'unresolved';
}

interface FusionOptions {
  /** How late speech recognition reports a word compared to when it was said. */
  lagMs: number;
  /** How far back from the word to look for what was pointed at. */
  windowMs: number;
  pins: ElementInfo[];
  selection: ElementInfo | null;
}

export const DEFAULT_FUSION: Omit<FusionOptions, 'pins' | 'selection'> = { lagMs: 380, windowMs: 650 };

/** English words lower-cased; Arabic words with their spelling folded (and a leading و, “and”, dropped). */
const clean = (w: string) => (/[\u0600-\u06FF]/.test(w) ? foldArabic(w).replace(/[^\u0600-\u06FF]/g, '').replace(/^و(?=..)/, '') : w.toLowerCase().replace(/[^a-z']/g, ''));

export function resolveDeictics(words: Word[], track: PointerTrack, opts: FusionOptions): ResolvedRef[] {
  const refs: ResolvedRef[] = [];
  const pins = opts.pins.slice();
  words.forEach((w, index) => {
    const word = clean(w.text);
    if (!DEICTIC.test(word) && !ARABIC_DEICTIC.test(word)) return;
    // "it" usually points back at the last thing mentioned.
    if (word === 'it' && refs.length) {
      refs.push({ ...refs[refs.length - 1], word, index, t: w.t });
      return;
    }
    if (pins.length) {
      refs.push({ word, index, t: w.t, el: pins.shift()!, via: 'pin' });
      return;
    }
    const center = w.t - opts.lagMs;
    let el = track.dwellWinner(center - opts.windowMs, center + 150) ?? track.at(center);
    let via: ResolvedRef['via'] = el ? 'pointing' : 'unresolved';
    if (!el && !refs.length && opts.selection) {
      el = opts.selection;
      via = 'selection';
    }
    // "that" pointing at the same thing as "this" almost always means the user hadn't moved yet.
    if (el && DISTAL.test(word) && refs.some((r) => r.el?.id === el!.id && !DISTAL.test(r.word))) {
      el = null;
      via = 'unresolved';
    }
    refs.push({ word, index, t: w.t, el, via });
  });
  return refs;
}

/** Targets for a command with no "this/that": pins, then the selection, then what was being pointed at. */
export function implicitTargets(pins: ElementInfo[], selection: ElementInfo | null, hovered: ElementInfo | null): ElementInfo[] {
  if (pins.length) return pins;
  if (selection) return [selection];
  return hovered ? [hovered] : [];
}
