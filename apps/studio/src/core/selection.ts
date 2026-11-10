/**
 * What is selected, and what a click (or ⇧ click) will do to it.
 *
 * One element is selected, or several picked together, in the order they were
 * picked (the first is "this", the second "that"). The store keeps the one
 * shown in the Inspector as `selection`, and the whole group, when there are
 * two or more, as `pins`.
 *
 * A click on what is highlighted selects just that; on what is the only thing
 * selected, deselects it; on empty space, clears. A ⇧ click adds what it is on
 * to the selection, or takes it out.
 */
import type { ElementInfo } from '@saywright/vite/protocol';
import { MAX_REFS } from '@shared/api';

export interface Picked {
  selection: ElementInfo | null;
  pins: ElementInfo[];
}

/** At most this many picked together. */
export const MAX_PICKED = MAX_REFS;

/** Everything selected, in the order it was picked. */
export function selectedOf(p: Picked): ElementInfo[] {
  return p.pins.length ? p.pins : p.selection ? [p.selection] : [];
}

/** These selected, `primary` (or the last picked) shown in the Inspector. */
export function picked(list: ElementInfo[], primary?: ElementInfo | null): Picked {
  const seen = new Set<number>();
  const unique = list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).slice(-MAX_PICKED);
  const main = (primary && unique.find((e) => e.id === primary.id)) || unique[unique.length - 1] || null;
  return { selection: main, pins: unique.length > 1 ? unique : [] };
}

/** In the selection, or added to the end of it. */
function toggled(now: ElementInfo[], el: ElementInfo): ElementInfo[] {
  return now.some((e) => e.id === el.id) ? now.filter((e) => e.id !== el.id) : [...now, el];
}

type TapMeaning = 'select' | 'only' | 'deselect' | 'clear' | 'none';
export type HoldMeaning = 'add' | 'remove' | 'none';

/** What a click, and a ⇧ click, on `target` (null: nothing highlighted) would do now. */
export function clickMeaning(target: ElementInfo | null, now: ElementInfo[]): { tap: TapMeaning; hold: HoldMeaning } {
  if (!target) return { tap: now.length ? 'clear' : 'none', hold: 'none' };
  const inside = now.some((e) => e.id === target.id);
  if (!inside) return { tap: 'select', hold: now.length ? 'add' : 'none' };
  // The only thing selected: a ⇧ click would do just what the click did.
  return now.length === 1 ? { tap: 'deselect', hold: 'none' } : { tap: 'only', hold: 'remove' };
}

/** After a click on `target`. */
export function afterTap(p: Picked, target: ElementInfo | null): Picked {
  const { tap } = clickMeaning(target, selectedOf(p));
  if (tap === 'select' || tap === 'only') return picked([target!]);
  if (tap === 'deselect' || tap === 'clear') return picked([]);
  return p;
}

/** Adding `target` would go over the limit: it isn't picked, and the studio says why (`PICKED_FULL`). */
export function pickedFull(p: Picked, target: ElementInfo | null): boolean {
  const now = selectedOf(p);
  return !!target && now.length >= MAX_PICKED && !now.some((e) => e.id === target.id);
}

/** What the studio says when one more element would go over the limit. */
export const PICKED_FULL = `At most ${MAX_PICKED} elements can be picked together. ⇧ click one of them to take it out first.`;

/** After a ⇧ click (or “add this”) on `target`: added, or taken out; never one over the limit (nothing picked is let go without a word). */
export function afterHold(p: Picked, target: ElementInfo | null): Picked {
  if (!target || pickedFull(p, target)) return p;
  const now = selectedOf(p);
  const next = toggled(now, target);
  return picked(next, next.length > now.length ? target : p.selection);
}

/** With `from` (one of the selected) swapped for `to`, in its place; `to` is now the one shown. */
export function replaced(p: Picked, from: ElementInfo, to: ElementInfo): Picked {
  return picked(
    selectedOf(p).map((e) => (e.id === from.id ? to : e)),
    to,
  );
}
