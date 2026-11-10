/**
 * Playing a test session back in the app, to check whether what went wrong
 * still does after a fix. Each step's Playwright locator (as the recorder
 * wrote it) is read, never run as code, found in the page the way Playwright
 * would find it, and acted on the way a person does: brought into view, then
 * clicked, filled or pressed.
 */
import { NAME_ATTR, SRC_ATTR } from '../protocol';
import { accessibleName, collapse, deepAll, fieldValue, isField, isVisible, labelText, shapeOf, writtenText } from './dom';
import { arm } from './guard';
import { ROLE_SELECTORS, roleFor } from './locator';
import { scriptedInput } from './own';

/** What the recorded element was: to find it again when its place in the code has moved. */
export interface Like {
  tag: string;
  /** Component name ("Button"), or the tag. */
  name: string;
  text: string;
  /** What it was made of (shapeOf), when the recorder knew. */
  shape?: string;
}

type Value = string | number | boolean | RegExp;
type Arg = Value | Record<string, Value>;
export interface Call {
  name: string;
  args: Arg[];
}

/** `page.getByRole('button', { name: 'Pay' }).nth(1)` → its calls; null for anything else. */
export function parseLocator(code: string): Call[] | null {
  const s = code.trim();
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const ident = (): string | null => {
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const str = (): string | null => {
    const quote = s[i];
    if (quote !== "'" && quote !== '"') return null;
    i++;
    let out = '';
    while (i < s.length && s[i] !== quote) {
      if (s[i] === '\\') {
        const n = s[i + 1];
        const hex = n === 'u' ? /^[0-9a-fA-F]{4}/.exec(s.slice(i + 2)) : null;
        if (hex) {
          out += String.fromCharCode(parseInt(hex[0], 16));
          i += 6;
          continue;
        }
        out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : (n ?? '');
        i += 2;
      } else out += s[i++];
    }
    if (s[i] !== quote) return null;
    i++;
    return out;
  };
  /** A regular expression literal, as the recorder writes one for a name with its numbers left open: `/^Pay \$\d[\d.,]*$/`. */
  const regex = (): RegExp | null => {
    const m = /^\/((?:[^/\\[\r\n]|\\.|\[(?:[^\]\\\r\n]|\\.)*\])+)\/([dgimsuy]*)/.exec(s.slice(i));
    if (!m) return null;
    try {
      const re = new RegExp(m[1], m[2].replace(/[gy]/g, ''));
      i += m[0].length;
      return re;
    } catch {
      return null;
    }
  };
  const value = (): Arg | null => {
    ws();
    if (s[i] === "'" || s[i] === '"') return str();
    if (s[i] === '/') return regex();
    const num = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    for (const [word, v] of [['true', true], ['false', false]] as const) {
      if (s.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    if (s[i] === '{') {
      i++;
      const obj: Record<string, Value> = {};
      for (;;) {
        ws();
        if (s[i] === '}') {
          i++;
          return obj;
        }
        const key = ident() ?? str();
        ws();
        if (!key || s[i] !== ':') return null;
        i++;
        const v = value();
        if (v === null || (typeof v === 'object' && !(v instanceof RegExp))) return null;
        obj[key] = v;
        ws();
        if (s[i] === ',') i++;
      }
    }
    return null;
  };
  ws();
  if (ident() !== 'page') return null;
  const calls: Call[] = [];
  for (;;) {
    ws();
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i++;
    const name = ident();
    ws();
    if (!name || s[i] !== '(') return null;
    i++;
    const args: Arg[] = [];
    for (;;) {
      ws();
      if (s[i] === ')') {
        i++;
        break;
      }
      const v = value();
      if (v === null) return null;
      args.push(v);
      ws();
      if (s[i] === ',') i++;
      else if (s[i] !== ')') return null;
    }
    calls.push({ name, args });
  }
  return calls.length ? calls : null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Playwright's matching: case-insensitive and partial by default, every word and nothing more when exact; a pattern as it is. */
function matches(actual: string, wanted: string | RegExp, exact: boolean): boolean {
  const a = norm(actual);
  if (wanted instanceof RegExp) return wanted.test(a);
  const w = norm(wanted);
  // Exact is every word and nothing more. Capitals aside: a style may show them, and a step recorded by an earlier
  // version was written from what the screen showed.
  return exact ? a.toLowerCase() === w.toLowerCase() : a.toLowerCase().includes(w.toLowerCase());
}

/** A pattern loosened to find what holds a match somewhere in its text (`^…$` let go). */
const loose = (re: RegExp) => new RegExp(re.source.replace(/^\^/, '').replace(/(?<!\\)\$$/, ''), re.flags);

/** Innermost elements whose text is (or, not exact, contains) `text`. */
function byText(scope: ParentNode, text: string | RegExp, exact: boolean): Element[] {
  // Without spaces: a line break is a space on the screen and nothing in the page's text.
  const needle = typeof text === 'string' ? text.replace(/\s+/g, '').toLowerCase() : '';
  const somewhere = text instanceof RegExp ? loose(text) : null;
  const hits: Element[] = [];
  const all = deepAll(scope === document ? document.body : scope, '*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el instanceof HTMLScriptElement || el instanceof HTMLStyleElement) continue;
    // Cheap first: the text must be in there somewhere.
    if (somewhere ? !somewhere.test(norm(el.textContent ?? '')) : !(el.textContent ?? '').replace(/\s+/g, '').toLowerCase().includes(needle)) continue;
    // What is written in it, as Playwright reads it (also a part marked private, which the studio never writes from),
    // or what it shows: a step recorded by an earlier version was written from the screen's words.
    if (isField(el)) continue;
    if (!matches(writtenText(el), text, exact) && !matches(collapse((el as HTMLElement).innerText ?? el.textContent, 80), text, exact)) continue;
    hits.push(el);
  }
  // Keep the innermost: drop any element that contains another hit.
  return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
}

const PLACE = new RegExp(`^\\[${SRC_ATTR}="(.+):(\\d+):(\\d+)"\\]$`);

/**
 * An element found by where it is written in the code (`[data-ds-src="file:line:col"]`, for elements with
 * nothing else to go by) moves when a fix adds or removes lines above it, and another element can take its
 * place. So it is looked for among the same kind of element in the same file: the nearest to where it was,
 * preferring the same text.
 */
function relocated(css: string, like: Like): Element[] | null {
  const m = PLACE.exec(css);
  if (!m) return null;
  const [, file, line, col] = m;
  const groups = new Map<string, Element[]>();
  for (const el of Array.from(document.querySelectorAll(`[${SRC_ATTR}^="${CSS.escape(`${file}:`)}"]`))) {
    const src = el.getAttribute(SRC_ATTR) ?? '';
    const tag = el.tagName.toLowerCase();
    // Named as the recorder names it: the component, else the tag.
    if (!/^\d+:\d+$/.test(src.slice(file.length + 1)) || tag !== like.tag || (el.getAttribute(NAME_ATTR) || tag) !== like.name) continue;
    const g = groups.get(src);
    if (g) g.push(el);
    else groups.set(src, [el]);
  }
  let best: { els: Element[]; score: number } | null = null;
  for (const [src, els] of groups) {
    const [l, c] = src.slice(file.length + 1).split(':').map(Number);
    const lines = Math.abs(l - Number(line));
    if (lines > 60) continue;
    // The same text is worth a few lines; the same make-up (an icon button's icon) more.
    const sameText = els.some((el) => (isField(el) ? '' : collapse(el.textContent, 80)) === like.text);
    const sameShape = !like.shape || els.some((el) => shapeOf(el) === like.shape);
    const score = lines + (sameText ? 0 : 3) + (sameShape ? 0 : 6) + Math.abs(c - Number(col)) / 100;
    if (!best || score < best.score) best = { els, score };
  }
  return best?.els ?? null;
}

/** The elements a parsed locator stands for, in page order (hidden ones too, as Playwright counts them for nth). */
function elementsFor(calls: Call[], like?: Like): Element[] | null {
  let set: Element[] | null = null;
  const scopes = (): ParentNode[] => (set ? set : [document]);
  const within = (pick: (scope: ParentNode) => Element[]) => {
    const out: Element[] = [];
    for (const sc of scopes()) for (const el of pick(sc)) if (!out.includes(el)) out.push(el);
    return out;
  };
  for (const c of calls) {
    const [a, b] = c.args;
    const opt = (typeof b === 'object' && !(b instanceof RegExp) ? b : {}) as { name?: string | RegExp; exact?: boolean };
    const text = (v: Arg | undefined): string | RegExp => (v instanceof RegExp ? v : String(v));
    switch (c.name) {
      case 'getByTestId':
        set = within((sc) => deepAll(sc, `[data-testid="${CSS.escape(String(a))}"]`));
        break;
      case 'getByRole': {
        const role = String(a);
        set = within((sc) => deepAll(sc, ROLE_SELECTORS[role] ?? `[role="${CSS.escape(role)}"]`).filter((el) => roleFor(el) === role && (opt.name == null || matches(accessibleName(el), text(opt.name), !!opt.exact))));
        break;
      }
      case 'filter': {
        // The card or row that has these words somewhere in it (or doesn't).
        const f = (typeof a === 'object' && !(a instanceof RegExp) ? a : {}) as { hasText?: string | RegExp; hasNotText?: string | RegExp };
        const found: Element[] = set ?? [];
        set = found.filter((el) => (f.hasText == null || matches(el.textContent ?? '', text(f.hasText), false)) && (f.hasNotText == null || !matches(el.textContent ?? '', text(f.hasNotText), false)));
        break;
      }
      case 'getByLabel':
        set = within((sc) => deepAll(sc, 'input, textarea, select, [aria-label]').filter((el) => matches(labelText(el) || el.getAttribute('aria-label') || '', text(a), !!opt.exact)));
        break;
      case 'getByPlaceholder':
        set = within((sc) => deepAll(sc, '[placeholder]').filter((el) => matches(el.getAttribute('placeholder') ?? '', text(a), !!opt.exact)));
        break;
      case 'getByText':
        set = within((sc) => byText(sc, text(a), !!opt.exact));
        break;
      case 'locator':
        try {
          set = (!set && like ? relocated(String(a), like) : null) ?? within((sc) => deepAll(sc, String(a)));
        } catch {
          return null;
        }
        break;
      case 'nth':
        set = set ? (set[Number(a) < 0 ? set.length + Number(a) : Number(a)] ? [set[Number(a) < 0 ? set.length + Number(a) : Number(a)]] : []) : [];
        break;
      case 'first':
        set = (set ?? []).slice(0, 1);
        break;
      case 'last':
        set = (set ?? []).slice(-1);
        break;
      default:
        return null;
    }
  }
  return set;
}

/**
 * The element a recorded locator points at now: its only visible match. When it matches several (every row's
 * “Delete”), the replay doesn't guess which, as Playwright wouldn't: acting on the first could change another record.
 */
export function find(code: string, like?: Like): { el: Element | null; reason?: string } {
  const calls = parseLocator(code);
  if (!calls) return { el: null, reason: 'unreadable' };
  const all = elementsFor(calls, like);
  if (!all) return { el: null, reason: 'unreadable' };
  const shown = all.filter(isVisible);
  if (shown.length > 1) return { el: null, reason: 'ambiguous' };
  const el = shown[0] ?? null;
  return el ? { el } : { el: null, reason: all.length ? 'hidden' : 'missing' };
}

/** The option a recorded choice names: by its value, else by what it says (as it was recorded, "Express"). */
function optionFor(el: HTMLSelectElement, wanted: string): HTMLOptionElement | undefined {
  const opts = Array.from(el.options);
  const said = (o: HTMLOptionElement) => norm(o.label || o.text);
  return opts.find((x) => x.value === wanted) ?? opts.find((x) => said(x) === norm(wanted)) ?? opts.find((x) => said(x).toLowerCase() === norm(wanted).toLowerCase());
}

/** Choose these options (all of them, in a list that takes several), as a person would: then input and change. */
function choose(el: HTMLSelectElement, wanted: string[]): void {
  const picked = wanted.map((w) => optionFor(el, w));
  if (!picked.length || picked.some((o) => !o)) throw new Error('no-option');
  if (el.multiple) for (const o of Array.from(el.options)) o.selected = picked.includes(o);
  else {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, picked[0]!.value);
    else el.value = picked[0]!.value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A control a person couldn't use now: disabled (itself or its fieldset), marked so, or in an inert part of the page. */
function unusable(el: Element): boolean {
  if (el.matches(':disabled')) return true;
  if (el.closest('[inert]')) return true;
  const control = el.closest('[aria-disabled]');
  return control?.getAttribute('aria-disabled') === 'true';
}

/** Set a field's value the way React expects (native setter, then input and change). */
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  // A list's choice was recorded by what it says ("Express"): pick that option, whatever its value.
  if (el instanceof HTMLSelectElement) return choose(el, [value]);
  // Files can't be chosen for the app: the person has to.
  if (el instanceof HTMLInputElement && el.type === 'file') throw new Error('file');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const pointer = (type: string, x: number, y: number) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 });
const mouse = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0, detail: 1 });

/**
 * Do one step on an element: as a person would, so the app (and its recorder) sees the same events. A control a
 * person couldn't use now (disabled, inert) is refused: clicking it would do nothing, and the replay would go on as
 * if it had worked.
 */
export function act(el: Element, step: { kind: 'click' | 'fill' | 'press'; value?: string; key?: string; checked?: boolean; select?: string[]; values?: string[]; byValue?: boolean; guard?: boolean }): void {
  if (unusable(el)) throw new Error('disabled');
  // Autopilot without leave to delete, pay, send or sign out: the page refuses those, whatever the control says.
  arm(!!step.guard);
  scriptedInput();
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (step.kind === 'click') {
    // What is on top at that point gets the press (an overlay over the button would, for a person too).
    const top = document.elementFromPoint(x, y);
    const target = top && (el === top || el.contains(top)) ? top : el;
    target.dispatchEvent(pointer('pointerdown', x, y));
    target.dispatchEvent(mouse('mousedown', x, y));
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    target.dispatchEvent(pointer('pointerup', x, y));
    target.dispatchEvent(mouse('mouseup', x, y));
    if (el instanceof HTMLElement) el.click();
    else target.dispatchEvent(mouse('click', x, y));
    return;
  }
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  if (step.kind === 'fill' && isField(el)) {
    // A box ticked or not, as it ended up (a session recorded before that was known: it changed).
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.checked !== (step.checked ?? !el.checked)) el.click();
      return;
    }
    // Options that say the same as another are chosen by their values; the rest by what they say.
    if (el instanceof HTMLSelectElement && step.byValue && step.values?.length) return choose(el, step.values);
    if (el instanceof HTMLSelectElement && step.select?.length) return choose(el, step.select);
    setValue(el, step.value ?? '');
    return;
  }
  if (step.kind === 'fill' && el instanceof HTMLElement && el.isContentEditable) {
    // A rich text editor: replace what it holds, the way typing would (editors listen for beforeinput/input).
    getSelection()?.selectAllChildren(el);
    if (!document.execCommand('insertText', false, step.value ?? '')) {
      el.textContent = step.value ?? '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: step.value ?? '' }));
    }
    return;
  }
  if (step.kind === 'fill') throw new Error('not-a-field');
  if (step.kind === 'press') {
    const key = step.key ?? 'Enter';
    const init = { key, code: key === 'Enter' ? 'Enter' : key, bubbles: true, cancelable: true, composed: true };
    const down = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    // A synthetic Enter doesn't submit a form by itself; a real one in a field would (unless the app stopped it).
    if (down && key === 'Enter' && el instanceof HTMLInputElement) el.form?.requestSubmit();
  }
}

/** What an element shows now, for checking what the tester said it should show (a secret as dots). */
export function textOf(el: Element): string {
  if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions, (o) => norm(o.label || o.text)).join(', ');
  return isField(el) ? fieldValue(el as HTMLInputElement) : collapse((el as HTMLElement).innerText ?? el.textContent ?? '', 400);
}
