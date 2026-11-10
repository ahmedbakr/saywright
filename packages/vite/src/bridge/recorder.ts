import { MASK, maskSecrets, type RecordedAction } from '../protocol';
import { collapse, editableOf, eventTarget, isVisible, typesInto, editedText, isField, isSecretEditor, isSecretField, secretNameOf } from './dom';
import { EnterSubmits } from './forms';
import { buildLocator } from './locator';

type Emit = (action: RecordedAction) => void;

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

/** Selectors of the page's style rules that show something while another part is hovered (`.menu:hover .submenu`). */
function hoverRules(): { whole: string; hovered: string }[] {
  const out: { whole: string; hovered: string }[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (!rule.selectorText.includes(':hover')) continue;
        const st = rule.style;
        if (!st.display && !st.visibility && !st.opacity && !st.maxHeight && !st.transform && !st.height && !st.clip && !st.clipPath) continue;
        for (const sel of rule.selectorText.split(',')) {
          const at = sel.lastIndexOf(':hover');
          if (at < 0) continue;
          // The hovered part: the selector up to the end of the compound that has :hover.
          const end = sel.slice(at).search(/[\s>+~]/);
          if (end < 0) continue;
          out.push({ whole: sel.trim(), hovered: sel.slice(0, at + end).trim() });
        }
      } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      /* another site's style sheet: its rules can't be read */
    }
  }
  return out;
}

/** The part whose hover, by the page's styles, shows `el` (or the part of it that is shown): null when none does. */
function hoverRuleShowing(el: Element): Element | null {
  for (const { whole, hovered } of hoverRules()) {
    try {
      for (let s: Element | null = el; s; s = s.parentElement) {
        if (!s.matches(whole)) continue;
        const h = s.parentElement?.closest(hovered);
        if (h && h.contains(el) && h !== el) return h;
      }
    } catch {
      /* a selector this browser doesn't take */
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
  private drewAt = 0;

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
    for (const part of this.revealing(el)) {
      const at = buildLocator(part);
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
   * The parts the pointer rested on that showed `el` (a menu that opens on hover): a test hovers over them first,
   * outermost first. A part counts when it was entered since the last step, and `el` did not show when it was, or
   * when the page's styles show it only while that part is hovered (`.menu:hover .submenu`).
   */
  private revealing(el: Element): Element[] {
    const out: Element[] = [];
    let cur: Element | null = el;
    while (cur && out.length < 4) {
      const by = this.revealedBy(cur);
      if (!by) break;
      out.unshift(by);
      cur = by;
    }
    return out;
  }

  private revealedBy(el: Element): Element | null {
    if (el.matches(INTERACTIVE)) {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const shown = this.entered.get(a);
        if (shown && (this.enteredAt.get(a) ?? 0) > this.stepAt && !shown.has(el) && a.matches(':hover')) return a;
      }
    }
    return hoverRuleShowing(el);
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
