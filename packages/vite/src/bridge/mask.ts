/**
 * While a session records, the screen it shares shows every secret field as dots and blurs what is marked private:
 * its screenshots and video are pictures of the screen, so this is what keeps a card number, a one-time code or a
 * key out of them, as the recorded text keeps it out of the events. The same rules decide what is secret (see dom.ts).
 *
 * Nothing may show before it is masked, even for a frame. A part marked private, and a field in it or marked so
 * itself, is masked by style alone, from the moment the mark is there. A field found secret by what it is for (a
 * password, a card number, an API key) is marked as it is added or changed, before the screen is drawn again.
 *
 * Inside a shadow root (a web component's fields) the page's style and observer reach nothing: each root gets its own.
 * One attached while recording gets it as it is made, before anything is put in it (and again if what is drawn in it
 * replaces it); open ones that were there already are found at the start, as their host is added, when one of their
 * fields is used, or by a sweep. All of it goes when the session ends.
 */
import { editableOf, isField, isSecretEditor, isSecretField, PRIVATE } from './dom';

const ATTR = 'data-saywright-masked';
const STYLE_ID = 'saywright-mask';
/** How often open roots attached some other way (from another document) are looked for. */
const SWEEP_MS = 1000;

let observer: MutationObserver | null = null;
let sweep: ReturnType<typeof setInterval> | null = null;
/** The shadow roots masked, each with the style it was given. */
const roots = new Map<ShadowRoot, HTMLStyleElement>();
/**
 * The page's own attachShadow (what was there before ours): what ours calls, put back when a session ends. Kept once
 * known, so anything that wrapped ours meanwhile still reaches it, and ours never calls itself.
 */
let nativeAttach: typeof Element.prototype.attachShadow | null = null;

/** The marks that make a part private (see PRIVATE): its attributes, and its classes. */
const MARKS = PRIVATE.split(',').map((s) => s.trim());
const MARK_ATTRS = MARKS.filter((s) => s.startsWith('[')).map((s) => s.slice(1, -1));
const MARK_CLASSES = MARKS.filter((s) => s.startsWith('.')).map((s) => s.slice(1));
/** What a field's secrecy is told from (see isSecretField and isSecretEditor), and what makes a part private. */
const WATCHED = ['type', 'name', 'id', 'autocomplete', 'aria-label', 'aria-placeholder', 'data-placeholder', 'placeholder', 'inputmode', 'title', 'data-testid', 'contenteditable', 'class', ...MARK_ATTRS];
const OBSERVE: MutationObserverInit = { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: WATCHED };

function css(): string {
  const priv = `:is(${PRIVATE})`;
  // A secret field shows dots, as does one marked private or in a part that is; a secret editor and every part marked
  // private are blurred as well (whatever their text is drawn with).
  return `[${ATTR}],${priv}:is(input,textarea),${priv} :is(input,textarea){-webkit-text-security:disc!important}[${ATTR}]:not(input):not(textarea),${priv}{filter:blur(6px)!important}`;
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

const hasMarkClass = (v: string | null): boolean => !!v && MARK_CLASSES.some((c) => ` ${v} `.includes(` ${c} `));

/** A root made while recording is masked as it is made: its style is in it before anything else is. */
function attachMasked(this: Element, init: ShadowRootInit): ShadowRoot {
  const root = nativeAttach!.call(this, init);
  cover(root);
  return root;
}

function onChange(records: MutationRecord[]): void {
  for (const r of records) {
    if (r.type === 'attributes') {
      const el = r.target;
      if (!(el instanceof Element)) continue;
      // A part marked private, or no longer: what is in it is told again (its look follows the mark by style alone).
      // A class that changes no privacy mark is nothing to it.
      if (r.attributeName === 'class') {
        if (hasMarkClass(el.getAttribute('class')) !== hasMarkClass(r.oldValue)) scan(el);
      } else if (r.attributeName && MARK_ATTRS.includes(r.attributeName)) scan(el);
      else mark(el);
      continue;
    }
    // A root's own style taken out (its component drew itself again): put back.
    for (const n of Array.from(r.removedNodes)) {
      if (!(n instanceof HTMLStyleElement) || !(r.target instanceof ShadowRoot)) continue;
      if (roots.get(r.target) === n) r.target.appendChild(n);
    }
    for (const n of Array.from(r.addedNodes)) if (n instanceof Element) scan(n);
  }
}

export function maskScreen(on: boolean): void {
  if (typeof document === 'undefined') return;
  if (!on) {
    observer?.disconnect();
    observer = null;
    if (sweep) clearInterval(sweep);
    sweep = null;
    // The page's own attachShadow back, unless something wrapped ours since (then ours only passes calls on).
    if (nativeAttach && Element.prototype.attachShadow === attachMasked) Element.prototype.attachShadow = nativeAttach;
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
  observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, OBSERVE);
  // A root made from now on is masked as it is made (as session-replay tools do it, by wrapping attachShadow).
  const current = Element.prototype.attachShadow;
  if (!nativeAttach) nativeAttach = current;
  if (current === nativeAttach) Element.prototype.attachShadow = attachMasked;
  scan(document);
  // An open root attached some other way makes no change an observer sees: looked for, in the page and in the roots
  // masked already (a root inside a root).
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
