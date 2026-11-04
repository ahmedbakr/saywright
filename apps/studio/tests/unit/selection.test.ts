import { describe, expect, it } from 'vitest';
import type { ElementInfo } from '@saywright/vite/protocol';
import { afterHold, afterTap, MAX_PICKED, picked, clickMeaning, replaced, selectedOf, type Picked } from '../../src/core/selection';

const el = (id: number, name = `El${id}`): ElementInfo => ({ id, src: `src/App.tsx:${id}:1`, name, tag: 'div', label: name, text: '', role: null, rect: { x: 0, y: 0, w: 10, h: 10 }, index: 0 });
const A = el(1, 'Pay');
const B = el(2, 'Apply');
const C = el(3, 'Total');
const NONE: Picked = { selection: null, pins: [] };
const ids = (p: Picked) => ({ selection: p.selection?.id ?? null, all: selectedOf(p).map((e) => e.id) });

describe('a pinch (or a click)', () => {
  it('selects what is highlighted, every time, with nothing else needed', () => {
    expect(ids(afterTap(NONE, A))).toEqual({ selection: 1, all: [1] });
    // Changing the selection is the same single pinch.
    expect(ids(afterTap(afterTap(NONE, A), B))).toEqual({ selection: 2, all: [2] });
  });

  it('on what is the only thing selected, deselects it', () => {
    expect(ids(afterTap(afterTap(NONE, A), A))).toEqual({ selection: null, all: [] });
  });

  it('on empty space, clears', () => {
    const two = afterHold(afterTap(NONE, A), B);
    expect(ids(afterTap(two, null))).toEqual({ selection: null, all: [] });
    expect(afterTap(NONE, null)).toBe(NONE);
  });

  it('on one of several selected, selects only that one', () => {
    const three = afterHold(afterHold(afterTap(NONE, A), B), C);
    expect(ids(afterTap(three, B))).toEqual({ selection: 2, all: [2] });
  });
});

describe('holding the pinch (or ⇧ click)', () => {
  it('adds to the selection, in the order picked: the first is “this”, the second “that”', () => {
    const two = afterHold(afterTap(NONE, A), B);
    expect(ids(two)).toEqual({ selection: 2, all: [1, 2] });
    expect(two.pins.map((e) => e.name)).toEqual(['Pay', 'Apply']);
  });

  it('takes out what is already selected, keeping the one shown when it stays', () => {
    const three = afterHold(afterHold(afterTap(NONE, A), B), C);
    expect(ids(afterHold(three, A))).toEqual({ selection: 3, all: [2, 3] });
    // Down to one: it is simply the selection.
    const one = afterHold(afterHold(three, A), B);
    expect(one).toEqual({ selection: C, pins: [] });
    expect(ids(afterHold(one, C))).toEqual({ selection: null, all: [] });
  });

  it('with nothing selected, selects', () => {
    expect(ids(afterHold(NONE, A))).toEqual({ selection: 1, all: [1] });
  });

  it('on empty space, changes nothing', () => {
    const two = afterHold(afterTap(NONE, A), B);
    expect(afterHold(two, null)).toBe(two);
  });

  it('keeps at most a handful, dropping the oldest', () => {
    let p = NONE;
    for (let i = 1; i <= MAX_PICKED + 3; i++) p = afterHold(p, el(i));
    expect(selectedOf(p)).toHaveLength(MAX_PICKED);
    expect(selectedOf(p)[0].id).toBe(4);
  });
});

describe('what a pinch would do, for the hint under the highlight', () => {
  it('names the tap and the hold', () => {
    expect(clickMeaning(A, [])).toEqual({ tap: 'select', hold: 'none' });
    expect(clickMeaning(B, [A])).toEqual({ tap: 'select', hold: 'add' });
    expect(clickMeaning(A, [A])).toEqual({ tap: 'deselect', hold: 'none' });
    expect(clickMeaning(A, [A, B])).toEqual({ tap: 'only', hold: 'remove' });
    expect(clickMeaning(null, [A])).toEqual({ tap: 'clear', hold: 'none' });
    expect(clickMeaning(null, [])).toEqual({ tap: 'none', hold: 'none' });
  });
});

describe('moving the selection (parent, inside, next, “the card”)', () => {
  it('moves the one shown, in its place among several', () => {
    const two = afterHold(afterTap(NONE, A), B);
    const card = el(9, 'ProductCard');
    expect(ids(replaced(two, B, card))).toEqual({ selection: 9, all: [1, 9] });
    expect(ids(replaced(afterTap(NONE, A), A, card))).toEqual({ selection: 9, all: [9] });
  });

  it('never lists the same element twice', () => {
    const two = afterHold(afterTap(NONE, A), B);
    expect(ids(replaced(two, B, A))).toEqual({ selection: 1, all: [1] });
    expect(ids(picked([A, B, A]))).toEqual({ selection: 2, all: [1, 2] });
  });
});
