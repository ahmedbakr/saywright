/**
 * While a session records, the screen it shares shows every secret field as dots and blurs what is marked private:
 * its screenshots and video are pictures of the screen, so this is what keeps a card number, a one-time code or a
 * key out of them, as the recorded text keeps it out of the events. The same rules decide what is secret (see dom.ts).
 *
 * Inside an open shadow root (a web component's fields) the page's style and observer reach nothing: each root gets
 * its own, when it is first seen (at the start, as its host is added, when one of its fields is used, or by a sweep
 * for roots attached later), and loses them when the session ends.
 */
import { editableOf, isField, isSecretEditor, isSecretField, PRIVATE } from './dom';

const ATTR = 'data-saywright-masked';
const STYLE_ID = 'saywright-mask';
/** How often roots attached after their host was added (with nothing used in them yet) are looked for. */
const SWEEP_MS = 1000;

let observer: MutationObserver | null = null;
let sweep: ReturnType<typeof setInterval> | null = null;
/** The open shadow roots masked, each with the style it was given. */
const roots = new Map<ShadowRoot, HTMLStyleElement>();

const OBSERVE: MutationObserverInit = { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder', 'inputmode'] };

function css(): string {
  const marked = PRIVATE.split(',')
    .map((s) => `${s.trim()}:not(input):not(textarea)`)
    .join(',');
  // A secret field shows dots; a secret editor (whatever its text is drawn with) is blurred as well.
  return `[${ATTR}]{-webkit-text-security:disc!important}[${ATTR}]:not(input):not(textarea),${marked}{filter:blur(6px)!important}`;
}

function mark(el: Element): void {
  if (isField(el) && !(el instanceof HTMLSelectElement) && isSecretField(el)) el.setAttribute(ATTR, '');
  else if (editableOf(el) === el && isSecretEditor(el)) el.setAttribute(ATTR, '');
}

/** Every secret field and editor in `scope` (itself too) marked, and every open shadow root in it masked. */
function scan(scope: Node): void {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
  for (let el = (scope instanceof Element ? scope : walker.nextNode()) as Element | null; el; el = walker.nextNode() as Element | null) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.hasAttribute('contenteditable')) mark(el);
    if (el.shadowRoot) cover(el.shadowRoot);
  }
}

/** Mask inside a shadow root: its own style and observer, its fields marked, the roots inside it too. */
function cover(root: ShadowRoot): void {
  if (!observer || roots.has(root)) return;
  const style = document.createElement('style');
  style.dataset.saywrightMask = '';
  style.textContent = css();
  root.appendChild(style);
  roots.set(root, style);
  observer.observe(root, OBSERVE);
  scan(root);
}

/** The shadow roots an element is in, outermost first: each is masked before the field in it is marked. */
function coverAround(el: Element): void {
  const around: ShadowRoot[] = [];
  for (let root = el.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) around.unshift(root);
  for (const r of around) cover(r);
}

/** A field can become secret as it is used: a card number typed into one, a password shown as text. */
const onUse = (e: Event): void => {
  const t = e.composedPath()[0] ?? e.target;
  if (!(t instanceof Element)) return;
  coverAround(t);
  mark(editableOf(t) ?? t);
};

export function maskScreen(on: boolean): void {
  if (typeof document === 'undefined') return;
  if (!on) {
    observer?.disconnect();
    observer = null;
    if (sweep) clearInterval(sweep);
    sweep = null;
    removeEventListener('input', onUse, true);
    removeEventListener('focusin', onUse, true);
    document.getElementById(STYLE_ID)?.remove();
    for (const el of Array.from(document.querySelectorAll(`[${ATTR}]`))) el.removeAttribute(ATTR);
    for (const [root, style] of roots) {
      style.remove();
      for (const el of Array.from(root.querySelectorAll(`[${ATTR}]`))) el.removeAttribute(ATTR);
    }
    roots.clear();
    return;
  }
  if (observer) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css();
  document.documentElement.appendChild(style);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target instanceof Element) mark(r.target);
        continue;
      }
      // A root's own style taken out (its component drew itself again): put back.
      for (const n of Array.from(r.removedNodes)) {
        if (!(n instanceof HTMLStyleElement) || !(r.target instanceof ShadowRoot)) continue;
        if (roots.get(r.target) === n) r.target.appendChild(n);
      }
      for (const n of Array.from(r.addedNodes)) if (n instanceof Element) scan(n);
    }
  });
  observer.observe(document.documentElement, OBSERVE);
  scan(document);
  // A root attached after its host was added makes no change an observer sees: looked for, in the page and in the
  // roots masked already (a root inside a root).
  const look = (scope: Node): void => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode() as Element | null; el; el = walker.nextNode() as Element | null) {
      const open = el.shadowRoot;
      if (!open) continue;
      if (roots.has(open)) look(open);
      else cover(open);
    }
  };
  sweep = setInterval(() => look(document), SWEEP_MS);
  addEventListener('input', onUse, true);
  addEventListener('focusin', onUse, true);
}
