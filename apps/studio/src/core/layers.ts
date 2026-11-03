/**
 * Modal layers over the studio: dialogs, the app list, a session's report.
 * While one is open, everything outside the topmost is inert (no focus, no
 * clicks, nothing for a screen reader) and the studio's own keyboard
 * shortcuts wait, so nobody can act on controls they can't see.
 */

const stack: HTMLElement[] = [];
/** What this module made inert, so only that is given back. */
const marked = new Set<Element>();
const NEVER = new Set(['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE']);

/** Keys a dialog let through while it fades out (it still sees them first, though it is closing). */
const passed = new WeakSet<Event>();

export function passThrough(e: Event): void {
  passed.add(e);
}

/** Whether a layer above took this key for itself. */
export function consumed(e: Event): boolean {
  return e.defaultPrevented && !passed.has(e);
}

export function modalOpen(): boolean {
  return stack.length > 0;
}

export function topLayer(): HTMLElement | null {
  return stack[stack.length - 1] ?? null;
}

/** Open `el` as the topmost layer; returns how to close it. */
export function openLayer(el: HTMLElement): () => void {
  if (!stack.includes(el)) stack.push(el);
  apply();
  return () => {
    const i = stack.indexOf(el);
    if (i >= 0) stack.splice(i, 1);
    apply();
  };
}

/** Inert: every sibling of the top layer and of each of its ancestors up to <body> (a backdrop that belongs to it excepted). */
function apply(): void {
  const top = topLayer();
  const want = new Set<Element>();
  for (let node: Element | null = top; node && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (sibling !== node && !NEVER.has(sibling.tagName) && !sibling.hasAttribute('data-layer-backdrop')) want.add(sibling);
    }
  }
  for (const el of marked) {
    if (want.has(el)) continue;
    el.removeAttribute('inert');
    marked.delete(el);
  }
  for (const el of want) {
    if (el.hasAttribute('inert')) continue;
    el.setAttribute('inert', '');
    marked.add(el);
  }
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';

/** What Tab reaches inside `el`, in order. */
export function tabbables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(TABBABLE)].filter((n) => n.tabIndex >= 0 && !n.closest('[inert]') && n.getClientRects().length > 0);
}

/** Tab and Shift+Tab go round inside `el` instead of leaving it. */
export function keepTabInside(e: KeyboardEvent, el: HTMLElement): void {
  const items = tabbables(el);
  const active = document.activeElement;
  if (!items.length) {
    e.preventDefault();
    el.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const inside = !!active && el.contains(active);
  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}
