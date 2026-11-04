import { NAME_ATTR, SRC_ATTR, parseSrc, type ElementInfo } from '../protocol';
import { annotatedAncestor, describe, isVisible, pageAnnotated, rectOf } from './dom';

function fileOf(el: Element): string | null {
  const src = el.getAttribute(SRC_ATTR);
  return src ? (parseSrc(src)?.file ?? null) : null;
}

/**
 * Pointing inside a component instance should select the instance (where its
 * props are set), not the component's internals. An element whose source file
 * differs from its nearest component-instance ancestor's file was rendered by
 * that component, so climb to the instance. Children passed in from the
 * instance's own file stay selectable.
 */
function collapseToInstance(el: Element): Element {
  let cur = el;
  for (let i = 0; i < 8; i++) {
    const parent = annotatedAncestor(cur.parentElement);
    if (!parent) break;
    if (!/^[A-Z]/.test(parent.getAttribute(NAME_ATTR) ?? '')) break;
    const a = fileOf(cur);
    const b = fileOf(parent);
    if (!a || !b || a === b) break;
    cur = parent;
  }
  return cur;
}

/** Elements this large are layout containers; pointing at them is rarely what anyone means. */
function isTooBig(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return r.width * r.height > vw * vh * 0.55 || (r.width >= vw * 0.96 && r.height >= vh * 0.5);
}

/** What a person clicks: pointing at the text or icon inside one means the whole thing. */
const CLICKABLE = 'a[href], button, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';

function candidateAt(x: number, y: number, deep: boolean): Element | null {
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
  const top = document.elementFromPoint(x, y);
  let el = annotatedAncestor(top);
  if (el && !deep) {
    el = collapseToInstance(el);
    const clickable = el.parentElement?.closest(CLICKABLE);
    if (clickable && annotatedAncestor(clickable) === clickable && !isTooBig(clickable)) el = collapseToInstance(clickable);
  }
  // Skip invisible wrappers and walk up to something worth highlighting.
  while (el && (!isVisible(el) || isTooBig(el))) {
    if (isTooBig(el)) return null;
    el = annotatedAncestor(el.parentElement);
  }
  return el;
}

function distanceToRect(x: number, y: number, el: Element): number {
  const r = rectOf(el);
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

const RING = Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2);

/**
 * Find what the user means at (x, y). A direct hit wins; otherwise "aim assist"
 * looks around the point within `radius` and picks the closest element. This is
 * what lets a shaky fingertip still land on a small button.
 */
function area(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

/** Ring search for the closest annotated element, optionally restricted to descendants of `within`. */
function nearest(x: number, y: number, radius: number, deep: boolean, within: Element | null): { el: Element; d: number } | null {
  const seen = new Set<Element>();
  let best: Element | null = null;
  let bestD = Infinity;
  const limit = within ? area(within) * 0.5 : Infinity;
  for (const frac of [0.45, 1]) {
    const r = radius * frac;
    for (const a of RING) {
      const el = candidateAt(x + Math.cos(a) * r, y + Math.sin(a) * r, deep);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (within && (el === within || !within.contains(el) || area(el) > limit)) continue;
      const d = distanceToRect(x, y, el);
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    }
    if (best) break; // prefer the inner ring when it finds something
  }
  return best && bestD <= radius ? { el: best, d: bestD } : null;
}

export function probe(x: number, y: number, radius: number, deep = false): { el: Element; info: ElementInfo; snapped: boolean } | null {
  const direct = candidateAt(x, y, deep);
  if (direct) {
    // Magnetic aim assist: over a container's padding, prefer the much smaller
    // element right next to the fingertip (a button, a row) over the container.
    if (radius > 0 && (pageAnnotated() ? direct.querySelector(`[${SRC_ATTR}]`) : direct.firstElementChild)) {
      const near = nearest(x, y, radius * 0.6, deep, direct);
      if (near) return { el: near.el, info: describe(near.el), snapped: true };
    }
    return { el: direct, info: describe(direct), snapped: false };
  }
  if (radius <= 0) return null;
  const near = nearest(x, y, radius, deep, null);
  return near ? { el: near.el, info: describe(near.el), snapped: true } : null;
}

let held: Element | null = null;

/**
 * For an unsteady pointer (an older studio's hand control asks for it): the
 * highlight stays on what it is on until the point clearly leaves it (a few
 * pixels past its edge) or moves onto something inside it. Without this the
 * highlight flickers between neighbours.
 */
export function probeSticky(x: number, y: number, radius: number, deep = false): { el: Element; info: ElementInfo; snapped: boolean } | null {
  const hit = probe(x, y, radius, deep);
  const prev = held;
  if (prev && hit?.el !== prev && prev.isConnected && isVisible(prev) && !(hit && prev.contains(hit.el))) {
    const r = rectOf(prev);
    const margin = 8;
    if (x >= r.x - margin && x <= r.x + r.w + margin && y >= r.y - margin && y <= r.y + r.h + margin) return { el: prev, info: describe(prev), snapped: hit?.el !== prev };
  }
  held = hit?.el ?? null;
  return hit;
}

/** The point left the app (or a mouse took over): nothing to hold on to. */
export function releaseSticky(): void {
  held = null;
}
