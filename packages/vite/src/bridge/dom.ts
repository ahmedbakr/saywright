import { dots, isCodeField, isSecretHint, looksSecret, maskSecrets, NAME_ATTR, secretName, SRC_ATTR, type ElementInfo, type Rect, type SourceHint } from '../protocol';
import { hasFiber, instanceFrames, ownSite, reactFrames } from './react';

const ids = new WeakMap<Element, number>();
const byId = new Map<number, WeakRef<Element>>();
let nextId = 1;

function idOf(el: Element): number {
  let id = ids.get(el);
  if (!id) {
    id = nextId++;
    ids.set(el, id);
    byId.set(id, new WeakRef(el));
  }
  return id;
}

export function elOf(id: number): Element | null {
  const el = byId.get(id)?.deref();
  if (!el || !el.isConnected) {
    byId.delete(id);
    return null;
  }
  return el;
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

export function collapse(s: string | null | undefined, max = 80): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Text as a person reads it on screen, line by line: blank lines dropped, spaces collapsed, long lines cut, whole
 * lines up to `max` characters, card numbers masked to their last four digits, and keys and tokens masked.
 */
export function screenLines(text: string, max: number, line = 200): string {
  const out: string[] = [];
  let size = 0;
  for (const raw of text.split('\n')) {
    const l = collapse(maskSecrets(raw), line);
    if (!l) continue;
    if (size + l.length + 1 > max) break;
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

/**
 * What an element is made of, in a few characters: its tag and classes, and a hash of what is inside it
 * (without Saywright's attributes or ids that change from one load to the next). Two icon buttons written one
 * under the other differ by their icon.
 */
export function shapeOf(el: Element): string {
  const html = el.innerHTML.replace(/\s(?:data-ds-[\w-]+|id|for|style|tabindex|data-state|aria-[\w-]+)="[^"]*"/g, '');
  let h = 5381;
  for (let i = 0; i < html.length; i++) h = ((h << 5) + h + html.charCodeAt(i)) | 0;
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 8).join('.');
  return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}#${(h >>> 0).toString(36)}`.slice(0, 200);
}

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
};

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0];
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
      return el.hasAttribute('href') ? 'link' : null;
    case 'input': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      // A password field has no role (as Playwright and screen readers see it): getByRole('textbox') never finds it.
      if (type === 'hidden' || type === 'password') return null;
      return INPUT_ROLES[type] ?? 'textbox';
    }
    case 'textarea':
      return 'textbox';
    case 'select':
      // A list that takes several choices, or shows several rows, is a listbox; a drop-down, a combobox.
      return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    case 'img':
      return el.getAttribute('alt') ? 'img' : null;
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'dialog':
      return 'dialog';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    default:
      return null;
  }
}

function textOfIds(ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

export function isField(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** What people already mark so that session-replay tools never record it (Saywright's own mark first). */
export const PRIVATE =
  '[data-saywright-secret], [data-private], [data-sensitive], [data-mask], [data-sentry-mask], [data-hj-suppress], [data-ph-no-capture], .rr-mask, .rr-block, .sentry-mask, .fs-mask, .fs-exclude, .hj-suppress, .ph-no-capture';

/** Password fields seen as such: one that “show password” turned into a text field still holds a password. */
const passwords = new WeakSet<Element>();

/** Words that describe a field: its type, name, id, autocomplete, label, placeholder and test id. */
function fieldHint(el: Element): string {
  return [
    (el as HTMLInputElement).type,
    el.getAttribute('name'),
    el.id,
    el.getAttribute('autocomplete'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('data-testid'),
    labelText(el),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Whether what is typed into this field is a secret, never to be recorded or shown: a password field (also once
 * “show password” has made it a text field), a field marked private (data-saywright-secret, or the marks other
 * replay tools use), one called like a secret (see isSecretHint), or one holding a value that looks like one.
 */
export function isSecretField(el: Element): boolean {
  if (!isField(el) || el instanceof HTMLSelectElement) return false;
  if (el instanceof HTMLInputElement && el.type === 'password') {
    passwords.add(el);
    return true;
  }
  if (passwords.has(el) || el.closest(PRIVATE)) return true;
  if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button', 'reset', 'image', 'hidden'].includes(el.type)) return false;
  const hint = fieldHint(el);
  return isSecretHint(hint) || looksSecret(el.value) || codeField(el, hint);
}

/** A short numeric code asked for to sign in (“Code”, “Enter the 6-digit code we emailed you”), though nothing says one-time. */
function codeField(el: HTMLInputElement | HTMLTextAreaElement, hint: string): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  const mode = (el.getAttribute('inputmode') ?? '').toLowerCase();
  const numeric = mode === 'numeric' || mode === 'decimal' || el.type === 'tel' || el.type === 'number' || /\\d|\[0-9/.test(el.pattern);
  return isCodeField(hint, { numeric, shortMax: el.maxLength >= 4 && el.maxLength <= 8 }, location.pathname);
}

/** What a test calls a secret field's value: PASSWORD, CARD_NUMBER… (from its label, else its name). */
export function secretNameOf(el: Element): string {
  if (el instanceof HTMLInputElement && el.type === 'password' && !isSecretHint(labelText(el) || el.getAttribute('placeholder') || el.getAttribute('name') || '')) return 'PASSWORD';
  if (isField(el) && !(el instanceof HTMLSelectElement) && !isSecretHint(fieldHint(el)) && codeField(el, fieldHint(el))) return 'ONE_TIME_CODE';
  return secretName(labelText(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('autocomplete') || el.getAttribute('name') || el.id || '');
}

/** What a field holds, as it may be shown or sent anywhere: a secret's value as dots, other values with any card number or key in them masked. */
export function fieldValue(el: HTMLInputElement | HTMLTextAreaElement): string {
  return isSecretField(el) ? dots(el.value) : maskSecrets(el.value);
}

/**
 * A label's own words, as Playwright and screen readers name a field by it: without the fields inside it (a list's
 * options, a text area's text), so `<label>Plan <select>…</select></label>` is “Plan”, not “Plan BasicPlus”.
 */
function labelWords(label: Element): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
    else if (n instanceof Element && !isField(n) && !(n instanceof HTMLButtonElement)) for (const c of Array.from(n.childNodes)) walk(c);
    else if (n instanceof HTMLButtonElement) out += n.textContent ?? '';
  };
  walk(label);
  return out;
}

/** Associated <label> text for a form field. */
export function labelText(el: Element): string {
  if (!isField(el)) return '';
  const parts: string[] = [];
  if (el.id) {
    for (const l of Array.from(document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`))) parts.push(labelWords(l));
  }
  const wrapping = el.closest('label');
  if (wrapping) parts.push(labelWords(wrapping));
  return collapse(parts.join(' '), 60);
}

/** A practical approximation of the accessible name (enough for stable test locators). */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return collapse(aria, 60);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) return collapse(textOfIds(labelledBy), 60);
  if (isField(el)) return labelText(el) || collapse(el.getAttribute('title'), 60);
  if (el instanceof HTMLImageElement) return collapse(el.alt, 60);
  const title = el.getAttribute('title');
  const text = collapse((el as HTMLElement).innerText ?? el.textContent, 60);
  return text || collapse(title, 60);
}

export function visibleText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // A secret's value is never anyone's text: not the studio's, a locator's, a report's or an AI's.
    return collapse(isSecretField(el) ? el.placeholder : el.value || el.placeholder, 80);
  }
  return collapse((el as HTMLElement).innerText ?? el.textContent, 80);
}

function shortLabel(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return collapse(aria, 28);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return collapse(labelText(el) || el.placeholder || (isSecretField(el) ? '' : el.value), 28);
  }
  return collapse((el as HTMLElement).innerText ?? el.textContent, 28);
}

/** Index of `el` among nodes rendered by the same JSX site (same data-ds-src). */
function srcIndex(el: Element, src: string | null): number {
  if (!src) return 0;
  const all = document.querySelectorAll(`[${SRC_ATTR}="${CSS.escape(src)}"]`);
  for (let i = 0; i < all.length; i++) if (all[i] === el) return i;
  return 0;
}

export function describe(el: Element): ElementInfo {
  // Without the Vite plugin's attribute, where it was written comes from React's or another framework's dev info (the studio server maps bundles back to source).
  const annotated = el.getAttribute(SRC_ATTR);
  const instances = annotated ? instanceFrames(el, SRC_ATTR, annotated) : [];
  const frames = annotated ? (instances.length ? [{ at: annotated, name: el.tagName.toLowerCase() }, ...instances] : []) : reactFrames(el);
  // React 19.0 only says which component wrote it (`inside`): the studio's server finds the line.
  const src = annotated ?? (frames.length ? (frames[0].inside ? null : frames[0].at) : pageAnnotated() ? null : frameworkSource(el));
  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute(NAME_ATTR) || tag;
  const short = shortLabel(el);
  const info: ElementInfo = {
    id: idOf(el),
    src,
    name,
    tag,
    label: short ? `${name} · ${short}` : name,
    text: visibleText(el),
    role: roleOf(el),
    rect: rectOf(el),
    index: srcIndex(el, src),
  };
  if (frames.length) info.frames = frames;
  if (!src) info.hint = sourceHint(el);
  return info;
}

type Meta = {
  __svelte_meta?: { loc?: { file?: string; line?: number; column?: number; char?: number } };
  __vueParentComponent?: { type?: { __file?: string } };
  __vue__?: { $options?: { __file?: string } };
};

const ASTRO_FILE = 'data-astro-source-file';
const ASTRO_LOC = 'data-astro-source-loc';
/** What Astro's source attributes said: its dev toolbar takes them off the page once it has read them. */
const astroSaid = new WeakMap<Element, { file?: string; loc?: string }>();

function keepAstroSources(): void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.oldValue === null || !(r.target instanceof Element)) continue;
      const said = astroSaid.get(r.target) ?? {};
      if (r.attributeName === ASTRO_FILE) said.file = r.oldValue;
      else said.loc = r.oldValue;
      astroSaid.set(r.target, said);
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: [ASTRO_FILE, ASTRO_LOC] });
}
// The bridge loads first in the page, before Astro's toolbar reads them.
keepAstroSources();

/** Where Astro wrote the element (its own attributes: Markdown content inside a layout has none, and isn't the layout's). */
function astroSource(el: Element): string | null {
  const file = el.getAttribute(ASTRO_FILE) ?? astroSaid.get(el)?.file;
  if (!file) return null;
  const loc = el.getAttribute(ASTRO_LOC) ?? astroSaid.get(el)?.loc;
  return `${file}:${loc && /^\d+:\d+$/.test(loc) ? loc : '1:1'}`;
}

/** Where another framework's development build says the element was written: Svelte, Astro, Vue's inspector. */
function frameworkSource(el: Element): string | null {
  const astro = astroSource(el);
  if (astro) return astro;
  const vue = el.closest('[data-v-inspector]')?.getAttribute('data-v-inspector');
  if (vue && /:\d+:\d+$/.test(vue)) return vue;
  const loc = (el as unknown as Meta).__svelte_meta?.loc;
  // Svelte 4 counts lines from 0 (and says where in characters); Svelte 5 from 1.
  if (loc?.file && typeof loc.line === 'number') return `${loc.file}:${loc.line + ('char' in loc ? 1 : 0)}:${(loc.column ?? 0) + 1}`;
  return null;
}

/** The component file Vue's development build names for the element (Vue 3, then Vue 2). */
function componentFile(el: Element): string | undefined {
  for (let cur: Element | null = el, i = 0; cur && i < 8; cur = cur.parentElement, i++) {
    const m = cur as unknown as Meta;
    const file = m.__vueParentComponent?.type?.__file ?? m.__vue__?.$options?.__file;
    if (file) return file;
  }
  return undefined;
}

const HINT_ATTRS = ['id', 'data-testid', 'data-test', 'data-cy', 'data-qa', 'name', 'for', 'aria-label', 'placeholder', 'alt', 'title', 'href', 'action', 'src'];

/** What can find an element in its code when nothing says where it was written. */
export function sourceHint(el: Element): SourceHint {
  const attrs: Record<string, string> = {};
  for (const a of HINT_ATTRS) {
    const v = el.getAttribute(a);
    if (v && v.length <= 200 && !v.startsWith('data:')) attrs[a] = v;
  }
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 12);
  if (classes.length) attrs.class = classes.join(' ');
  const file = componentFile(el);
  return file ? { attrs, file } : { attrs };
}

let annotated = false;
let checkedAt = -Infinity;

/**
 * Whether the page carries the Vite plugin's source attributes. A page can
 * render them later, so a "no" is checked again, but at most every two
 * seconds: this runs on every pointer move, and a miss scans the whole page.
 */
export function pageAnnotated(): boolean {
  if (annotated) return true;
  const now = performance.now();
  if (now - checkedAt < 2000) return false;
  checkedAt = now;
  annotated = !!document.querySelector(`[${SRC_ATTR}]`);
  return annotated;
}

/**
 * The nearest annotated element at or above `el`. Pages without the Vite
 * plugin (Next.js, Create React App) have no annotations: there, any element
 * React rendered counts. On a page with neither (plain HTML, another
 * framework, a production build, a site shown through the studio's proxy),
 * every element counts as it is.
 */
export function annotatedAncestor(el: Element | null): Element | null {
  if (!el) return null;
  if (pageAnnotated()) {
    // Parts the plugin didn't annotate (files outside its reach) still count where React says where they were written.
    for (let cur: Element | null = el; cur && cur !== document.body; cur = cur.parentElement) {
      if (cur.hasAttribute(SRC_ATTR)) return cur;
      // The drawing inside an icon is the icon, as the plugin annotates it.
      if (!(cur instanceof SVGElement && cur.parentElement instanceof SVGElement) && ownSite(cur)) return cur;
    }
    return null;
  }
  const found = el.closest(`[${SRC_ATTR}]`);
  if (found) return found;
  for (let cur: Element | null = el; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
    if (hasFiber(cur)) return cur;
  }
  return plainElement(el);
}

/** An element of a page without annotations or React: the drawing inside an icon is the icon; the page itself and the recorder's button are nothing. */
function plainElement(el: Element): Element | null {
  let cur = el;
  while (cur instanceof SVGElement && cur.parentElement instanceof SVGElement) cur = cur.parentElement;
  if (cur === document.body || cur === document.documentElement || cur === document.head || cur.closest('saywright-recorder')) return null;
  return cur;
}
