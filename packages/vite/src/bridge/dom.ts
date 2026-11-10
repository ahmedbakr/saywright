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

/** The page's open shadow roots (nested ones too), as last looked for. */
let shadows: { at: number; roots: ShadowRoot[] } = { at: -Infinity, roots: [] };

/**
 * The page's open shadow roots, nested ones too: what Playwright's locators see into. Looked for again at most once a
 * second (a page of thousands of elements takes a few milliseconds), or at once for an element in one not seen yet.
 */
export function shadowRoots(seen?: Node): ShadowRoot[] {
  const now = performance.now();
  const root = seen?.getRootNode();
  if (now - shadows.at < 1000 && !(root instanceof ShadowRoot && !shadows.roots.includes(root))) return shadows.roots;
  const roots: ShadowRoot[] = [];
  const walk = (scope: Node) => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode() as Element | null; el; el = walker.nextNode() as Element | null) {
      const open = el.shadowRoot;
      if (open) {
        roots.push(open);
        walk(open);
      }
    }
  };
  walk(document);
  shadows = { at: now, roots };
  return roots;
}

/** Whether `node` is in `scope`, counting what is in the open shadow roots of what is in it. */
function within(scope: ParentNode, node: Node): boolean {
  for (let n: Node | null = node; n; ) {
    if (scope === n || (scope instanceof Node && scope.contains(n))) return true;
    const root = n.getRootNode();
    n = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/**
 * What `selector` matches in `scope`, and in each open shadow root in it, as lists to go through in place (a page of
 * thousands of buttons isn't copied for each count).
 */
export function deepLists(scope: ParentNode, selector: string): ArrayLike<Element>[] {
  const lists: ArrayLike<Element>[] = [scope.querySelectorAll(selector)];
  for (const root of shadowRoots()) if (root !== scope && within(scope, root.host)) lists.push(root.querySelectorAll(selector));
  return lists;
}

/** Every element `selector` matches in `scope`, and in the open shadow roots in it: as Playwright's locators find them. */
export function deepAll(scope: ParentNode, selector: string): Element[] {
  const lists = deepLists(scope, selector);
  return lists.length === 1 ? Array.from(lists[0]) : lists.flatMap((l) => Array.from(l));
}

/** The element edited as a whole (contenteditable: a rich text editor) that `el` is in, or null. */
export function editableOf(el: Element | null): HTMLElement | null {
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return null;
  let host: HTMLElement = el;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

/**
 * The element an event happened on, also inside an open shadow root: a listener on the window or the document sees
 * only the root's host as `e.target`.
 */
export function eventTarget(e: Event): Element | null {
  const t = e.composedPath()[0] ?? e.target;
  return t instanceof Element ? t : null;
}

/**
 * Whether a key pressed now goes into something the person types in: a field or a rich text editor, also inside a
 * web component. A closed shadow root shows nothing of itself but its host: when the focus is in one, it may be a
 * field, so the key is taken for typing (a space must never be swallowed in a field).
 */
export function typesInto(e: Event): boolean {
  const t = eventTarget(e);
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return true;
  return t.localName.includes('-') && !t.shadowRoot && document.activeElement === t;
}

/** What a rich text editor holds, as its text: line by line, without the line break it ends with. */
export const editedText = (el: HTMLElement) => (el.innerText ?? el.textContent ?? '').replace(/\n+$/, '');

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
  image: 'button',
};
/** Inputs typed into: with a list of suggestions (a datalist), a combobox. */
const TYPED_INPUTS = new Set(['text', 'search', 'email', 'tel', 'url']);

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
      // A field that suggests from a datalist is a combobox, as Playwright finds it (getByRole('textbox') never does).
      if (TYPED_INPUTS.has(type) && el.hasAttribute('list')) return 'combobox';
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

/** The words of the elements these ids name, in `el`'s own document or shadow root (where its ids are). */
function textOfIds(el: Element, ids: string): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => (id ? (root.getElementById?.(id)?.textContent ?? '') : ''))
    .join(' ');
}

export function isField(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** What people already mark so that session-replay tools never record it (Saywright's own mark first). */
export const PRIVATE =
  '[data-saywright-secret], [data-private], [data-sensitive], [data-mask], [data-sentry-mask], [data-hj-suppress], [data-ph-no-capture], .rr-mask, .rr-block, .sentry-mask, .fs-mask, .fs-exclude, .hj-suppress, .ph-no-capture';

/** Whether `el` is in a part of the page marked private (see PRIVATE), also through the shadow roots it is in. */
export function inPrivate(el: Element): boolean {
  for (let n: Element | null = el; n; ) {
    if (n.closest(PRIVATE)) return true;
    const root = n.getRootNode();
    n = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

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
  if (passwords.has(el) || inPrivate(el)) return true;
  if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button', 'reset', 'image', 'hidden'].includes(el.type)) return false;
  const hint = fieldHint(el);
  return isSecretHint(hint) || looksSecret(el.value) || codeField(el, hint);
}

/**
 * Whether what is typed into a rich text editor (contenteditable) is a secret, as for a field (see isSecretField): one
 * marked private, itself or a part of the page it is in, one called like a secret, or one holding what looks like one.
 */
export function isSecretEditor(el: Element): boolean {
  if (editableOf(el) !== el) return false;
  if (inPrivate(el)) return true;
  const hint = [el.getAttribute('aria-label'), el.getAttribute('aria-placeholder'), el.getAttribute('data-placeholder'), el.getAttribute('title'), el.id, el.getAttribute('data-testid')].filter(Boolean).join(' ');
  return isSecretHint(hint) || looksSecret(editedText(el as HTMLElement));
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
  const name = ownSecretName(el);
  // “Confirm password” in a form that sets a new one is the new one, typed again: NEW_PASSWORD, not the sign-in's.
  if (name === 'PASSWORD' && /\b(?:confirm|repeat|retype|re-?enter|again|verify)\b/i.test(fieldHint(el))) {
    const form = el.closest('form') ?? el.parentElement?.closest('section, fieldset, div');
    for (const other of Array.from(form?.querySelectorAll('input') ?? [])) {
      if (other === el || !isSecretField(other)) continue;
      const theirs = ownSecretName(other);
      if (theirs !== 'PASSWORD' && /PASSWORD$/.test(theirs)) return theirs;
    }
  }
  return name;
}

function ownSecretName(el: Element): string {
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

/** Roles of a control that is checked or not, as Playwright's toBeChecked reads it. */
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

const isToggle = (el: Element) => (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) || TOGGLE_ROLES.has(el.getAttribute('role') ?? '');

/**
 * The control whose state something pointed at stands for: an option's list, a label's checkbox, the checkbox or
 * switch it is part of; else itself.
 */
export function controlOf(el: Element): Element {
  if (el instanceof HTMLOptionElement || el instanceof HTMLOptGroupElement) return el.closest('select') ?? el;
  if (isToggle(el) || el instanceof HTMLSelectElement) return el;
  const label = el.closest('label');
  const labelled = label?.control ?? label?.querySelector('input, select');
  if (labelled && (isToggle(labelled) || labelled instanceof HTMLSelectElement)) return labelled;
  return el.closest('[role="checkbox"], [role="radio"], [role="switch"], [role="menuitemcheckbox"], [role="menuitemradio"]') ?? el;
}

/** A state check's facts: whether the control is checked; for an option of a list, what it says and what is chosen now. */
export function stateOf(pointed: Element, control: Element): { checked?: boolean; option?: string; chosen?: string[] } {
  if (control instanceof HTMLSelectElement) {
    const option = pointed instanceof HTMLOptionElement ? collapse(pointed.label || pointed.text, 80) : undefined;
    return { ...(option ? { option } : {}), chosen: Array.from(control.selectedOptions, (o) => collapse(o.label || o.text, 80)) };
  }
  if (control instanceof HTMLInputElement && isToggle(control)) return { checked: control.checked };
  if (isToggle(control)) return { checked: control.getAttribute('aria-checked') === 'true' };
  return {};
}

/** Associated <label> text for a form field. */
export function labelText(el: Element): string {
  if (!isField(el)) return '';
  const parts: string[] = [];
  if (el.id) {
    // A label is for a field in its own document or shadow root.
    const root = el.getRootNode() as Document | ShadowRoot;
    for (const l of Array.from(root.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`))) parts.push(labelWords(l));
  }
  const wrapping = el.closest('label');
  if (wrapping) parts.push(labelWords(wrapping));
  return collapse(parts.join(' '), 60);
}

/**
 * What inside an element changes its name from its text: an image's alt, an icon's label, a part kept from screen
 * readers (an arrow or an icon written as text, which no name holds).
 */
export const NAMED_INSIDE = 'img[alt], [aria-label], [aria-hidden="true"]';

const NAME_MAX = 200;

/**
 * A practical approximation of the accessible name (enough for stable test locators). Whole up to 200 characters:
 * a locator is never written from a cut one (it would find nothing).
 */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return collapse(aria, NAME_MAX);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) return collapse(textOfIds(el, labelledBy), NAME_MAX);
  // A button made of an input is named by its words (value), an image button by its alt, as Playwright names them.
  if (el instanceof HTMLInputElement && /^(submit|button|reset)$/i.test(el.type)) {
    return collapse(el.value, NAME_MAX) || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '') || collapse(el.getAttribute('title'), NAME_MAX);
  }
  if (el instanceof HTMLInputElement && el.type === 'image') return collapse(el.alt || el.value, NAME_MAX) || collapse(el.getAttribute('title'), NAME_MAX) || 'Submit';
  if (isField(el)) return labelText(el) || collapse(el.getAttribute('title'), NAME_MAX);
  // A text box (a rich text editor) isn't named by what is typed into it.
  if (editableOf(el) === el || el.getAttribute('role') === 'textbox') return collapse(el.getAttribute('title'), NAME_MAX);
  if (el instanceof HTMLImageElement) return collapse(el.alt, NAME_MAX);
  const title = el.getAttribute('title');
  const text = collapse(el.querySelector(NAMED_INSIDE) ? contentName(el) : asWritten((el as HTMLElement).innerText ?? el.textContent ?? '', el.textContent ?? ''), NAME_MAX);
  return text || collapse(title, NAME_MAX);
}

/**
 * What the screen shows, with its letters as the page holds them: a style that shows capitals (text-transform) changes
 * what is seen, not what is written, and a test finds an element by what is written. Only when they are the same
 * words; else as shown.
 */
export function asWritten(shown: string, written: string): string {
  const letters = written.replace(/\s+/g, '');
  const seen = shown.replace(/\s+/g, '');
  if (letters === seen || letters.length !== seen.length || letters.toLowerCase() !== seen.toLowerCase()) return shown;
  let i = 0;
  return shown.replace(/\S/g, () => letters[i++]);
}

/**
 * What an element shows (see visibleText), with its letters as the page holds them: what a test reads there when it
 * runs, so a check said of “ACTIVE” on a badge that a style writes in capitals expects the “Active” the page holds.
 * A field's value, an editor's text and a private part are left as they are.
 */
export function shownText(el: Element): string {
  const shown = visibleText(el);
  if (!shown || isField(el) || editableOf(el) || inPrivate(el)) return shown;
  return asWritten(shown, el.textContent ?? '');
}

/** Elements whose text no text locator reads. */
const UNREAD = /^(?:SCRIPT|NOSCRIPT|STYLE)$/;

/**
 * Every text written in an element, as Playwright's getByText reads it: shown or not, a shadow root's after its own,
 * a script's and a style's left out, spaces as they are. Not what the screen shows (innerText): a line break adds
 * no space here, and a style that shows capitals changes nothing.
 */
export function writtenText(root: Element | ShadowRoot, inner: (part: Element | ShadowRoot) => string = writtenText): string {
  if (root instanceof Element && UNREAD.test(root.nodeName)) return '';
  let out = '';
  for (let c = root.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === Node.TEXT_NODE) out += c.nodeValue ?? '';
    else if (c.nodeType === Node.ELEMENT_NODE) out += inner(c as Element);
  }
  if (root instanceof Element && root.shadowRoot) out += inner(root.shadowRoot);
  return out;
}

/**
 * An element's name from what is inside it, as Playwright and screen readers read it: text, an image's alt, a part's
 * own label; hidden parts left out, a block on its own words. A link that is only a picture is named by the picture.
 */
function contentName(el: Element): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? '';
      return;
    }
    if (!(n instanceof Element) || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden')) return;
    const { display, visibility } = getComputedStyle(n);
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return;
    // A line break is a space between its words, as a block is.
    const pad = display !== 'inline' || n.nodeName === 'BR' ? ' ' : '';
    const own = n.getAttribute('aria-label') || (n instanceof HTMLImageElement ? n.alt : null);
    if (own !== null && own !== '') out += `${pad}${own}${pad}`;
    else if (!(n instanceof HTMLImageElement)) {
      out += pad;
      for (const c of Array.from(n.childNodes)) walk(c);
      out += pad;
    }
  };
  for (const c of Array.from(el.childNodes)) walk(c);
  return out;
}

export function visibleText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // A secret's value is never anyone's text: not the studio's, a locator's, a report's or an AI's.
    return collapse(isSecretField(el) ? el.placeholder : el.value || el.placeholder, 80);
  }
  // A list shows what is chosen in it, not every option it has.
  if (el instanceof HTMLSelectElement) return collapse(Array.from(el.selectedOptions, (o) => o.label || o.text).join(', '), 80);
  // Nor is what a secret editor holds, or what a part marked private says (its pictures blur it).
  const editor = editableOf(el);
  if (editor && isSecretEditor(editor)) return collapse(editor.getAttribute('aria-placeholder') ?? editor.getAttribute('data-placeholder'), 80);
  if (inPrivate(el)) return '';
  // An element that holds such a part says the rest of what it says.
  return collapse(screenText(el as HTMLElement, ''), 80);
}

/** Whether what `el` says is kept to the page: it is in a part marked private, or in a secret rich text editor. */
export function hidesText(el: Element): boolean {
  const editor = editableOf(el);
  return inPrivate(el) || (!!editor && isSecretEditor(editor));
}

/** What can be marked private, or edited as a whole: where what an element says is looked through for what to leave out. */
const HIDDEN_PARTS = `${PRIVATE}, [contenteditable]:not([contenteditable="false"])`;

/** A part whose words are kept to the page: marked private, or a secret rich text editor. */
const hidden = (part: Element) => part.matches(PRIVATE) || (editableOf(part) === part && isSecretEditor(part));

/**
 * What an element says on screen, as a session's text and Autopilot read it: what a part marked private says, and what
 * is typed into a secret editor, left out (as its pictures blur it), each line of it replaced by `mark`.
 */
export function screenText(el: HTMLElement, mark = '•••'): string {
  const text = el.innerText ?? el.textContent ?? '';
  if (inPrivate(el)) return mark;
  if (!el.querySelector(HIDDEN_PARTS)) return text;
  let out = text;
  for (const part of Array.from(el.querySelectorAll<HTMLElement>(HIDDEN_PARTS))) {
    if (!hidden(part)) continue;
    for (const line of (part.innerText ?? part.textContent ?? '').split('\n')) {
      const l = line.trim();
      if (l) out = out.split(l).join(mark);
    }
  }
  return out;
}

/** An element's words as its text holds them (textContent: cheap, no layout), without what its private parts hold. */
export function publicText(el: Element): string {
  if (hidesText(el)) return '';
  if (!el.querySelector(HIDDEN_PARTS)) return el.textContent ?? '';
  let out = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n instanceof Element && hidden(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
  return out;
}

function shortLabel(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return collapse(aria, 28);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return collapse(labelText(el) || el.placeholder || (isSecretField(el) ? '' : el.value), 28);
  }
  return collapse((el as HTMLElement).innerText ?? el.textContent, 28);
}

/** Index of `el` among nodes rendered by the same JSX site (same data-ds-src), and how many there are. */
function srcIndex(el: Element, src: string | null): { index: number; same: number } {
  if (!src) return { index: 0, same: 1 };
  const all = document.querySelectorAll(`[${SRC_ATTR}="${CSS.escape(src)}"]`);
  for (let i = 0; i < all.length; i++) if (all[i] === el) return { index: i, same: all.length };
  return { index: 0, same: all.length };
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
    index: 0,
  };
  const at = srcIndex(el, annotated);
  info.index = at.index;
  if (at.same > 1) info.same = at.same;
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
