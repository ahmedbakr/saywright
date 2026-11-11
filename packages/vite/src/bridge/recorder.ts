import { MASK, maskSecrets, type RecordedAction } from '../protocol';
import { collapse, editableOf, eventTarget, isVisible, typesInto, editedText, isField, isSecretEditor, isSecretField, secretNameOf } from './dom';
import { EnterSubmits } from './forms';
import { buildLocator } from './locator';

type Emit = (action: RecordedAction) => void;

/** Kept in the tab while Write test records, for the next page of a full page load (see `resume`). */
const ON_KEY = 'saywright.record';

const INTERACTIVE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], input, select, textarea, summary, label';
const TEXTUAL = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', '']);
/** Inputs whose value is picked rather than typed: a test sets it (fill does, as the input keeps it: 2026-11-20). */
const PICKED = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
const KEY_NAME: Record<string, string> = { ArrowDown: '↓', ArrowUp: '↑', Escape: 'Escape' };
/** Keys an app may answer when the focus is not in a field (with no modifier: with one, any key is a shortcut). */
const PAGE_KEYS = /^(Arrow(Up|Down|Left|Right)|Escape|Delete|Backspace|Home|End|PageUp|PageDown|F\d{1,2})$/;
/** How far the pointer moves, button down, before it draws rather than clicks. */
const GESTURE_PX = 10;
/** The most controls a hovered part may hold for the recorder to note which of them showed (a menu, not a page). */
const SNAPSHOT_MAX = 300;

/**
 * A key as Playwright presses it, with its modifiers: Control+k, Shift+Enter, Meta+Shift+P. A letter or digit held
 * with Control, Alt or Meta is named by the key itself, not by the character a layout makes of it (Alt+n is not “ñ”).
 */
export function keyName(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): string {
  const held = e.ctrlKey || e.altKey || e.metaKey;
  let key = e.key === ' ' ? 'Space' : e.key;
  if (held && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (held && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  // Shift with a character is in the character already (“?”, “K”); with a named key or a shortcut it is said.
  const shift = e.shiftKey && (key.length > 1 || held);
  return [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta', shift && 'Shift', key].filter(Boolean).join('+');
}

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXTUAL.has((el.type || '').toLowerCase());
}
const isPicked = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && PICKED.has((el.type || '').toLowerCase());
const isFile = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'file';
const isToggle = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
/** A field that offers a list to choose from as you type (a WAI-ARIA combobox, or an input with a datalist). */
const isCombobox = (el: Element) => el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || (el instanceof HTMLInputElement && !!el.list);

/** What an option is called: its label, else its text. */
const optionName = (o: HTMLOptionElement) => collapse(o.label || o.text, 80);

/** The element an event happened on, also inside an open shadow root (where the page sees only the root's host). */
const targetOf = eventTarget;

/** The selectors of a list (`a, b:is(c, d)`), split at its own commas. */
function selectorsOf(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  let quote = '';
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '\\') i++;
    else if (quote) quote = ch === quote ? '' : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(from, i));
      from = i + 1;
    }
  }
  out.push(list.slice(from));
  return out.map((one) => one.trim()).filter(Boolean);
}

/** Whether a selector with `:hover` in it is about another element than the hovered one: something comes after it. */
function showsAnother(selector: string): boolean {
  const at = selector.lastIndexOf(':hover');
  if (at < 0) return false;
  let depth = 0;
  for (let i = at + 6; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth <= 0 && /[\s>+~]/.test(ch)) return true;
  }
  return false;
}

/** A style rule that shows something while another part is hovered: one selector of it, and what it declares. */
interface HoverRule {
  /** With its nesting written out (`&` is the rule it is in). */
  selector: string;
  display: string;
  visibility: string;
  opacity: string;
  /** It declares a size, a transform or a clip: nothing to compare with what the element has now. */
  other: boolean;
}

let hoverRulesRead: { at: number; rules: HoverRule[] } = { at: -Infinity, rules: [] };

/**
 * The page's style rules that show something while another part is hovered: `.menu:hover .submenu`, the same
 * written with nesting (`.menu { &:hover .submenu { … } }`), and Tailwind's `group-hover:block`, which it writes
 * `:is(:where(.group):hover .group-hover\:block)` under `@media (hover: hover)`. Read again at most once a second.
 */
function hoverRules(): HoverRule[] {
  const now = performance.now();
  if (now - hoverRulesRead.at < 1000) return hoverRulesRead.rules;
  const out: HoverRule[] = [];
  type Declared = Omit<HoverRule, 'selector'>;
  // What a rule declares itself, and under a condition nested in it (`@media (hover: hover) { display: block }`).
  const declared = (rule: CSSRule, into: Declared = { display: '', visibility: '', opacity: '', other: false }): Declared => {
    const st = (rule as Partial<CSSStyleRule>).style;
    if (st) {
      into.display ||= st.display;
      into.visibility ||= st.visibility;
      into.opacity ||= st.opacity;
      into.other ||= !!(st.maxHeight || st.height || st.transform || st.clip || st.clipPath);
    }
    for (const inner of Array.from((rule as Partial<CSSGroupingRule>).cssRules ?? [])) if (!(inner instanceof CSSStyleRule)) declared(inner, into);
    return into;
  };
  const walk = (rules: CSSRuleList, parent: string | null) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        // A nested rule's selector is its parent's with its own: `&` stands for the parent, and without one it is inside it.
        const full = parent === null ? rule.selectorText : selectorsOf(rule.selectorText).map((one) => (one.includes('&') ? one.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${one}`)).join(', ');
        if (full.includes(':hover')) {
          const says = declared(rule);
          if (says.display || says.visibility || says.opacity || says.other) {
            for (const selector of selectorsOf(full)) {
              if (!showsAnother(selector)) continue;
              try {
                document.documentElement.matches(selector);
                out.push({ selector, ...says });
              } catch {
                /* a selector this browser doesn't take */
              }
            }
          }
        }
        if (rule.cssRules?.length) walk(rule.cssRules, full);
      } else if (rule instanceof CSSImportRule) {
        try {
          if (rule.styleSheet) walk(rule.styleSheet.cssRules, parent);
        } catch {
          /* another site's style sheet: its rules can't be read */
        }
      } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules, parent);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules, null);
    } catch {
      /* another site's style sheet: its rules can't be read */
    }
  }
  hoverRulesRead = { at: now, rules: out };
  return out;
}

/** Whether a declared value is the one the element has (a keyword or a variable can't be compared: taken as it). */
const declaredIs = (declared: string, has: string) => !!declared && (/^(?:inherit|initial|unset|revert|revert-layer)$|var\(/.test(declared) || declared === has || (/^[\d.]+%?$/.test(declared) && Math.abs(parseFloat(declared) / (declared.endsWith('%') ? 100 : 1) - parseFloat(has)) < 0.01));

/**
 * The innermost part of the page that holds `el` (or is it) and that a style shows only while something else is
 * hovered: a rule's selector matches it now, and what the rule declares is what it has (a rule that only dims the
 * other links of a bar is not what shows the one under the pointer). Null when none does.
 */
function shownByHover(el: Element): Element | null {
  const rules = hoverRules();
  if (!rules.length) return null;
  for (let s: Element | null = el; s && s !== document.body; s = s.parentElement) {
    let has: CSSStyleDeclaration | null = null;
    for (const rule of rules) {
      if (!s.matches(rule.selector)) continue;
      has ??= getComputedStyle(s);
      if (rule.other || declaredIs(rule.display, has.display) || declaredIs(rule.visibility, has.visibility) || declaredIs(rule.opacity, has.opacity)) return s;
    }
  }
  return null;
}

/**
 * Records what the user does in the app as Playwright steps: clicks, text
 * entry (one `fill` per field, flushed on change, blur or Enter; a rich text
 * editor's text too), choices in lists (every option chosen, in a list that
 * takes several) and Enter, in open shadow roots as well. A secret (a password,
 * a card number…) is recorded by its name alone: what was typed never leaves
 * the page.
 */
export class Recorder {
  private on = false;
  private pendingFill = new Map<Element, ReturnType<typeof setTimeout>>();
  private submits = new EnterSubmits();
  /** Shadow roots listened to: a change in one (a box ticked, an option chosen) never reaches the document. */
  private roots = new WeakSet<ShadowRoot>();
  /** What a part of the page held, visible, when the pointer entered it (since the last step): what hovering it showed. */
  private entered = new WeakMap<Element, WeakSet<Element>>();
  private stepAt = 0;
  private dragged: Element | null = null;
  private inFrame = false;
  /** A pointer pressed on a canvas: where, and whether it then drew (moved, held down). */
  private press: { x: number; y: number; on: Element; drew: boolean } | null = null;
  /** When a shape was last drawn on a canvas: never, at first (a click in a page's first moments is a click). */
  private drewAt = -Infinity;

  constructor(private send: Emit) {
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('input', this.onInput, true);
    document.addEventListener('change', this.onChange, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('blur', this.onBlur, true);
    document.addEventListener('focusin', this.onFocus, true);
    document.addEventListener('dblclick', this.onDblClick, true);
    document.addEventListener('contextmenu', this.onContextMenu, true);
    document.addEventListener('dragstart', this.onDragStart, true);
    document.addEventListener('drop', this.onDrop, true);
    document.addEventListener('dragend', () => (this.dragged = null), true);
    document.addEventListener('pointerover', this.onOver, true);
    document.addEventListener('pointerenter', this.onEnter, true);
    document.addEventListener('pointermove', this.onPointerMove, true);
    document.addEventListener('pointerup', this.onPointerUp, true);
    // The focus went into an embedded frame: what is done there is another page's, which this one can't see.
    window.addEventListener('blur', () => setTimeout(this.intoFrame, 0));
    window.addEventListener('focus', () => (this.inFrame = false));
    // A page left for another (a link, a form sent, location.href): what was being typed is a step before it goes.
    window.addEventListener('pagehide', () => {
      if (this.on) this.flushAll();
    });
  }

  private emit = (action: RecordedAction) => {
    this.stepAt = performance.now();
    this.send(action);
  };

  setOn(on: boolean): void {
    if (!on) this.flushAll();
    this.on = on;
    this.answerDialogs(on);
    try {
      if (on) sessionStorage.setItem(ON_KEY, '1');
      else sessionStorage.removeItem(ON_KEY);
    } catch {
      /* storage blocked: the next page records once the studio has told it to */
    }
  }

  /**
   * Carry on in a page opened by a full page load (a link, a form sent, location.href) while Write test records.
   * The page before this one left word in the tab, so what is done here is recorded from the moment this script
   * runs, not from when the studio has greeted the page and told it again. The studio still says whether it records
   * as it greets each page, which settles it either way.
   */
  resume(): void {
    try {
      if (sessionStorage.getItem(ON_KEY) === '1') this.setOn(true);
    } catch {
      /* storage blocked */
    }
  }

  /** The page's own dialogs, while ours stand in for them (recording); put back as they were when it stops. */
  private native: Pick<Window, 'alert' | 'confirm' | 'prompt'> | null = null;
  private wrapped: Pick<Window, 'alert' | 'confirm' | 'prompt'> | null = null;

  /**
   * While recording, the browser's dialogs are the page's as before, and how the person answered each is kept with
   * the step that opened it: a test (where Playwright cancels every dialog nobody answers) answers it the same way,
   * so the app takes the same branch. Outside recording the page's own functions are back, untouched.
   */
  private answerDialogs(on: boolean): void {
    if (on && !this.native) {
      const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
      const said = (message: unknown) => (message === undefined ? '' : collapse(maskSecrets(String(message)), 120));
      const emit = this.emit;
      this.native = native;
      this.wrapped = {
        alert(message?: unknown) {
          native.alert.call(window, message);
          emit({ kind: 'dialog', dialog: { type: 'alert', accept: true, message: said(message) } });
        },
        confirm(message?: string) {
          const ok = native.confirm.call(window, message);
          emit({ kind: 'dialog', dialog: { type: 'confirm', accept: ok, message: said(message) } });
          return ok;
        },
        prompt(message?: string, value?: string) {
          const answer = native.prompt.call(window, message, value);
          // What was typed into a prompt is kept as typed, unless it looks like a key or a card number.
          emit({ kind: 'dialog', dialog: { type: 'prompt', accept: answer !== null, ...(answer !== null ? { text: maskSecrets(answer) } : {}), message: said(message) } });
          return answer;
        },
      };
      Object.assign(window, this.wrapped);
    } else if (!on && this.native && this.wrapped) {
      // Only what is still ours goes back: something the page put there since stays.
      for (const name of ['alert', 'confirm', 'prompt'] as const) if (window[name] === this.wrapped[name]) (window as unknown as Record<string, unknown>)[name] = this.native[name];
      this.native = null;
      this.wrapped = null;
    }
  }

  /** Send the text still being typed now: what comes next (a check said about the page) comes after it. */
  flushAll(): void {
    for (const el of Array.from(this.pendingFill.keys())) this.flush(el);
  }

  /** Listen for changes in the shadow root `el` is in, once: they don't reach the document. */
  private watch(el: Element | null): void {
    const root = el?.getRootNode();
    if (!(root instanceof ShadowRoot) || this.roots.has(root)) return;
    this.roots.add(root);
    root.addEventListener('change', this.onChange, true);
  }

  private onFocus = (e: FocusEvent) => {
    const t = targetOf(e);
    this.watch(t);
    // A password field is remembered as one before anything is typed, should “show password” make it a text field.
    if (this.on && t && isField(t)) isSecretField(t);
  };

  /** What was being typed comes before what is clicked now: a combobox's suggestion keeps the focus in its field. */
  private onPointerDown = (e: PointerEvent) => {
    const t = targetOf(e);
    this.watch(t);
    if (!this.on) return;
    this.press = t instanceof HTMLCanvasElement && e.button === 0 ? { x: e.clientX, y: e.clientY, on: t, drew: false } : null;
    for (const el of Array.from(this.pendingFill.keys())) if (!t || !el.contains(t)) this.flush(el);
  };

  private onClick = (e: Event) => {
    if (!this.on) return;
    const t = targetOf(e);
    if (!t) return;
    if (editableOf(t)) return; // a click into a rich text editor: its `fill` is the step
    const el = t.closest(INTERACTIVE) ?? t;
    if (isTextField(el) || isPicked(el)) return; // focusing a field is implied by `fill`
    if (isToggle(el)) return; // a box or a radio: its change is the step (check)
    if (el instanceof HTMLSelectElement || el instanceof HTMLOptionElement) return; // the choice is the step
    if (this.submits.isSubmitClick(e as MouseEvent, el)) return; // the Enter step already submits the form
    if (isFile(el)) return; // the files chosen are the step (setInputFiles)
    // A label passes its click on to its control, and the control's own step says what happened.
    if (el instanceof HTMLLabelElement && el.control && (isTextField(el.control) || el.control instanceof HTMLSelectElement || isPicked(el.control) || isToggle(el.control) || isFile(el.control))) return;
    // The end of a shape drawn on a canvas, not a click (it is noted as not recorded).
    if (performance.now() - this.drewAt < 400) return;
    for (const over of this.hovers(el)) {
      const at = buildLocator(over);
      this.emit({ kind: 'hover', locator: at.code, description: `Hover over ${at.description}` });
    }
    const loc = buildLocator(el);
    this.emit({ kind: 'click', locator: loc.code, description: `Click ${loc.description}` });
  };

  /** A double click: one step (a test's two clicks never make a dblclick). The studio puts it in place of its two clicks. */
  private onDblClick = (e: MouseEvent) => {
    if (!this.on) return;
    const t = targetOf(e);
    if (!t || editableOf(t)) return;
    const el = t.closest(INTERACTIVE) ?? t;
    if (isTextField(el) || isPicked(el) || isToggle(el) || isFile(el) || el instanceof HTMLSelectElement || el instanceof HTMLOptionElement) return;
    const loc = buildLocator(el);
    this.emit({ kind: 'click', locator: loc.code, count: 2, description: `Double-click ${loc.description}` });
  };

  private onContextMenu = (e: MouseEvent) => {
    if (!this.on) return;
    const t = targetOf(e);
    if (!t || editableOf(t)) return;
    const el = t.closest(INTERACTIVE) ?? t;
    if (isTextField(el)) return; // the browser's own menu (paste): what it does to the field is its fill
    const loc = buildLocator(el);
    this.emit({ kind: 'click', locator: loc.code, button: 'right', description: `Right-click ${loc.description}` });
  };

  private onDragStart = (e: DragEvent) => {
    const t = targetOf(e);
    this.dragged = t && (t.closest('[draggable="true"]') ?? t);
  };

  /** An HTML drag and drop: what was dragged, onto what (Playwright's dragTo does both). */
  private onDrop = (e: DragEvent) => {
    const from = this.dragged;
    this.dragged = null;
    const t = targetOf(e);
    if (!this.on || !from || !t || !from.isConnected) return;
    // Files dropped from the computer have nothing in the page to start from.
    if (from === t || from.contains(t)) return;
    const onto = t.closest(`${INTERACTIVE}, [draggable="true"], li, tr, [role="listitem"], [role="row"]`) ?? t;
    this.flushAll();
    const src = buildLocator(from);
    const to = buildLocator(onto);
    this.emit({ kind: 'drag', locator: src.code, to: to.code, description: `Drag ${src.description} onto ${to.description}` });
  };

  /** Where the pointer has been, lately (kept whether recording or not: a page's first moments come before it is told). */
  private path: { on: Element; at: number }[] = [];

  private onOver = (e: Event) => {
    const on = targetOf(e);
    if (!on) return;
    this.path.push({ on, at: performance.now() });
    if (this.path.length > 80) this.path.splice(0, 40);
  };

  /** The pointer entered part of the page: note which controls in it showed, to tell later what hovering it revealed. */
  private onEnter = (e: Event) => {
    if (!this.on) return;
    const a = targetOf(e);
    if (!a || a === document.documentElement || a === document.body) return;
    const all = a.querySelectorAll(INTERACTIVE);
    if (!all.length || all.length > SNAPSHOT_MAX) return;
    const shown = new WeakSet<Element>();
    for (const c of Array.from(all)) if (isVisible(c)) shown.add(c);
    this.entered.set(a, shown);
    this.enteredAt.set(a, performance.now());
  };
  private enteredAt = new WeakMap<Element, number>();

  /**
   * What a test hovers over before it clicks `el`, outermost first, when `el` shows only while something is hovered
   * (a menu): what the pointer was last on outside what opened, since the last step. That is the menu's own word
   * (“Products”), there before anything opened and found again whatever the menu holds; and what showed that in
   * turn (a menu in a menu).
   */
  private hovers(el: Element): Element[] {
    const out: Element[] = [];
    for (let cur = el; out.length < 4; ) {
      const opened = this.openedByHover(cur);
      const over = opened && this.lastOutside(opened.what, opened.within);
      if (!over || over === cur || out.includes(over)) break;
      out.unshift(over);
      cur = over;
    }
    return out;
  }

  /**
   * What a hover opened that holds `el`: the part a style shows only while something is hovered (`.menu:hover
   * .submenu`), or, opened by the page's code, the piece of a part that was entered since the last step when `el`
   * did not show in it (`within`: that part). Of the two, the one inside: the pointer crosses what is around a menu
   * on its way to it (a bar, a header), and `el` did not show then either.
   */
  private openedByHover(el: Element): { what: Element; within?: Element } | null {
    const styled = shownByHover(el);
    let part: Element | null = null;
    if (el.matches(INTERACTIVE)) {
      for (let a = el.parentElement; a && a !== document.body && !part; a = a.parentElement) {
        const shown = this.entered.get(a);
        if (shown && (this.enteredAt.get(a) ?? 0) > this.stepAt && !shown.has(el) && a.matches(':hover')) part = a;
      }
    }
    let piece: Element | null = part && el;
    while (piece && piece.parentElement && piece.parentElement !== part) piece = piece.parentElement;
    if (styled && (!piece || piece.contains(styled))) return { what: styled };
    return part && piece ? { what: piece, within: part } : null;
  }

  /**
   * What the pointer was last on, since the last step, outside `what` (and inside `within`, when what opened was
   * opened by the page's code): the control it is part of, a menu's own word before the menu's bare surface. With
   * none on record, the part the page's code opened it in; null for a style's (the pointer never left what it shows).
   */
  private lastOutside(what: Element, within?: Element): Element | null {
    const ok = (on: Element) => on.isConnected && on !== document.body && on !== document.documentElement && !what.contains(on) && (!within || within.contains(on)) && isVisible(on);
    for (let i = this.path.length - 1; i >= 0 && this.path[i].at > this.stepAt; i--) {
      let on = this.path[i].on;
      if (!ok(on)) continue;
      // The surface of what holds the menu (the pointer crossed its edge): what it was on in there before, if anything.
      if (on.contains(what)) {
        for (let j = i - 1; j >= 0 && this.path[j].at > this.stepAt; j--) {
          const before = this.path[j].on;
          if (before !== on && on.contains(before) && !before.contains(what) && ok(before)) {
            on = before;
            break;
          }
        }
      }
      const control = on.closest(INTERACTIVE);
      return control && !control.contains(what) && ok(control) ? control : on;
    }
    return within ?? null;
  }

  private onPointerMove = (e: PointerEvent) => {
    const p = this.press;
    if (!p || !(e.buttons & 1) || p.drew) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > GESTURE_PX) p.drew = true;
  };

  private onPointerUp = () => {
    const p = this.press;
    this.press = null;
    if (!this.on || !p?.drew) return;
    this.drewAt = performance.now();
    this.flushAll();
    this.emit({ kind: 'missed', description: 'Not recorded: a shape drawn with the pointer on a canvas' });
  };

  /** The focus is now in an embedded frame (once until it comes back): what is done there is not recorded. */
  private intoFrame = () => {
    if (!this.on || this.inFrame) return;
    let a: Element | null = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (!(a instanceof HTMLIFrameElement || a instanceof HTMLFrameElement || a instanceof HTMLObjectElement || a instanceof HTMLEmbedElement)) return;
    this.inFrame = true;
    this.flushAll();
    this.emit({ kind: 'missed', description: 'Not recorded: something you did inside an embedded frame' });
  };

  private onInput = (e: Event) => {
    const t = targetOf(e);
    this.watch(t);
    if (!this.on || !t) return;
    // What is typed into a rich text editor is the whole editor's text.
    const el = isTextField(t) ? t : editableOf(t);
    if (!el) return;
    const prev = this.pendingFill.get(el);
    if (prev) clearTimeout(prev);
    this.pendingFill.set(el, setTimeout(() => this.flush(el), 1200));
  };

  private onChange = (e: Event) => {
    if (!this.on) return;
    const el = targetOf(e);
    if (!el) return;
    if (isTextField(el)) this.flush(el);
    else if (isFile(el)) {
      // The files' names and types: never what is in them (a test uploads an empty file of each name).
      this.flushAll();
      const files = Array.from(el.files ?? [], (f) => ({ name: f.name, mimeType: f.type || 'application/octet-stream' }));
      const loc = buildLocator(el);
      const said = files.length ? files.map((f) => `“${collapse(f.name, 60)}”`).join(', ') : 'no file';
      this.emit({ kind: 'upload', locator: loc.code, files, description: `Choose ${said} in ${loc.description}` });
    } else if (isPicked(el)) {
      // A date typed a part at a time changes as each part is done: its last value is the step.
      const prev = this.pendingFill.get(el);
      if (prev) clearTimeout(prev);
      this.pendingFill.set(el, setTimeout(() => this.flush(el), 600));
    } else if (isToggle(el)) {
      const loc = buildLocator(el);
      const did = el.type === 'radio' ? 'Choose' : el.checked ? 'Check' : 'Uncheck';
      this.emit({ kind: 'fill', locator: loc.code, value: '', checked: el.checked, description: `${did} ${loc.description}` });
    } else if (el instanceof HTMLSelectElement) {
      const loc = buildLocator(el);
      const chosen = Array.from(el.selectedOptions);
      const names = chosen.map(optionName);
      const said = names.length ? names.map((n) => `“${n}”`).join(', ') : 'nothing';
      // Two options that say the same (“Standard”, “Standard”): only their values tell them apart.
      const all = Array.from(el.options, optionName);
      const byValue = names.some((n) => all.filter((x) => x === n).length > 1);
      this.emit({
        kind: 'fill',
        locator: loc.code,
        value: chosen[0]?.value ?? '',
        select: names,
        values: chosen.map((o) => o.value),
        ...(byValue ? { byValue: true } : {}),
        description: `Choose ${said} in ${loc.description}`,
      });
    }
  };

  private onBlur = (e: Event) => {
    if (!this.on) return;
    const t = targetOf(e);
    const el = t && (this.pendingFill.has(t) ? t : editableOf(t));
    if (el && this.pendingFill.has(el)) this.flush(el);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.on || e.repeat || e.isComposing) return;
    if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph|Dead|Unidentified|Process)$/.test(e.key)) return;
    const held = e.ctrlKey || e.altKey || e.metaKey;
    const el = targetOf(e);
    if (KEY_NAME[e.key] && !held && !e.shiftKey && el && isCombobox(el)) {
      // Choosing from a combobox's list with the keyboard: what was typed, then each key.
      if (this.pendingFill.has(el)) this.flush(el);
      const loc = buildLocator(el);
      this.emit({ kind: 'press', locator: loc.code, key: e.key, description: `Press ${KEY_NAME[e.key]} in ${loc.description}` });
      return;
    }
    if (e.key === 'Enter') {
      this.submits.keydown(e);
      if (el && isField(el)) {
        if (this.pendingFill.has(el)) this.flush(el);
        const loc = buildLocator(el);
        // Shift+Enter (a new line in a chat box) is never written as Enter (which sends it).
        const key = keyName(e);
        this.emit({ kind: 'press', locator: loc.code, key, description: `Press ${key} in ${loc.description}` });
        return;
      }
    }
    // Typing in a field is its fill; and the studio's own keys are never steps: Space (talk), and Alt+Shift+M (mark).
    if (typesInto(e)) return;
    if (e.key === ' ' || (e.altKey && e.shiftKey && e.code === 'KeyM')) return;
    // Enter, Space and Tab outside a field press a button or move the focus: the click or the fill is the step.
    if (!held && (e.key === 'Enter' || e.key === 'Tab')) return;
    if (!held && e.key.length !== 1 && !PAGE_KEYS.test(e.key)) return;
    // An app's shortcut or key (n, ?, Control+k, Escape), pressed on the page as the person did, after what was typed.
    this.flushAll();
    const key = keyName(e);
    this.emit({ kind: 'press', key, description: `Press ${key}` });
  };

  private flush(el: Element): void {
    const t = this.pendingFill.get(el);
    if (t) clearTimeout(t);
    if (!this.pendingFill.delete(el)) return;
    if (isPicked(el)) {
      const loc = buildLocator(el);
      this.emit({ kind: 'fill', locator: loc.code, value: el.value, description: `Set ${loc.description} to “${collapse(el.value, 60)}”` });
      return;
    }
    const editor = editableOf(el);
    if (editor === el) {
      const loc = buildLocator(editor);
      if (isSecretEditor(editor)) {
        // Marked private or called like a secret: by its name only, as a secret field is, typed from the environment.
        this.emit({ kind: 'fill', locator: loc.code, value: '', secret: secretNameOf(editor), description: `Type ${MASK} into ${loc.description}` });
        return;
      }
      // A rich text editor: its text as a whole, as fill puts it back (any card number or key in it masked).
      const value = maskSecrets(editedText(editor));
      this.emit({ kind: 'fill', locator: loc.code, value, description: `Type “${collapse(value, 60)}” into ${loc.description}` });
      return;
    }
    if (!isTextField(el)) return;
    const loc = buildLocator(el);
    if (isSecretField(el)) {
      // Its name only: a test types it from the environment (SAYWRIGHT_SECRET_PASSWORD), the studio from what you saved.
      this.emit({ kind: 'fill', locator: loc.code, value: '', secret: secretNameOf(el), description: `Type ${MASK} into ${loc.description}` });
      return;
    }
    const value = maskSecrets(el.value);
    this.emit({ kind: 'fill', locator: loc.code, value, description: `Type “${collapse(value, 60)}” into ${loc.description}` });
  }
}
