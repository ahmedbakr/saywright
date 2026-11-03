import { describe, expect, it } from 'vitest';
import type { ElementInfo } from '@saywright/vite/protocol';
import { DEFAULT_FUSION, PointerTrack, implicitTargets, resolveDeictics } from '../../src/core/fusion';

const el = (id: number, name: string): ElementInfo => ({ id, src: `src/a.tsx:${id}:1`, name, tag: 'button', label: name, text: name, role: 'button', rect: { x: 0, y: 0, w: 10, h: 10 }, index: 0 });
const APPLY = el(1, 'Apply');
const PAY = el(2, 'Pay');

function track(): PointerTrack {
  const t = new PointerTrack();
  for (let ms = 0; ms <= 1000; ms += 30) t.push(ms, APPLY);
  for (let ms = 1010; ms <= 2200; ms += 30) t.push(ms, PAY);
  return t;
}
const words = (pairs: [string, number][]) => pairs.map(([text, t]) => ({ text, t }));
const opts = { ...DEFAULT_FUSION, pins: [], selection: null };

describe('resolveDeictics', () => {
  it('binds this and that to what was pointed at while saying them (allowing for recognition lag)', () => {
    const refs = resolveDeictics(words([['make', 400], ['this', 900], ['look', 1100], ['like', 1300], ['that', 1900]]), track(), opts);
    expect(refs.map((r) => [r.word, r.el?.name, r.via])).toEqual([
      ['this', 'Apply', 'pointing'],
      ['that', 'Pay', 'pointing'],
    ]);
  });

  it('uses pins in order when there are any', () => {
    const refs = resolveDeictics(words([['this', 1900], ['that', 1950]]), track(), { ...opts, pins: [PAY, APPLY] });
    expect(refs.map((r) => r.el?.name)).toEqual(['Pay', 'Apply']);
    expect(refs.every((r) => r.via === 'pin')).toBe(true);
  });

  it('leaves "that" unresolved when it would repeat "this", so the user can point', () => {
    const t = new PointerTrack();
    for (let ms = 0; ms <= 3000; ms += 30) t.push(ms, APPLY);
    const refs = resolveDeictics(words([['this', 900], ['that', 1900]]), t, opts);
    expect(refs[1]).toMatchObject({ word: 'that', el: null, via: 'unresolved' });
  });

  it('"it" refers back to the last reference', () => {
    const refs = resolveDeictics(words([['this', 900], ['make', 1000], ['it', 1900]]), track(), opts);
    expect(refs[1].el?.name).toBe('Apply');
  });

  it('falls back to the selection when nothing was pointed at', () => {
    const refs = resolveDeictics(words([['this', 500]]), new PointerTrack(), { ...opts, selection: PAY });
    expect(refs[0]).toMatchObject({ el: PAY, via: 'selection' });
  });
});

describe('implicitTargets', () => {
  it('prefers pins, then selection, then hover', () => {
    expect(implicitTargets([PAY], APPLY, null)).toEqual([PAY]);
    expect(implicitTargets([], APPLY, PAY)).toEqual([APPLY]);
    expect(implicitTargets([], null, PAY)).toEqual([PAY]);
    expect(implicitTargets([], null, null)).toEqual([]);
  });
});
