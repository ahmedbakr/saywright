import { MASK, maskSecrets, type RecordedAction } from '../protocol';
import { collapse, editableOf, editedText, isField, isSecretField, secretNameOf } from './dom';
import { EnterSubmits } from './forms';
import { buildLocator } from './locator';

type Emit = (action: RecordedAction) => void;

const INTERACTIVE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], input, select, textarea, summary, label';
const TEXTUAL = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', '']);
/** Inputs whose value is picked rather than typed: a test sets it (fill does, as the input keeps it: 2026-11-20). */
const PICKED = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
const KEY_NAME: Record<string, string> = { ArrowDown: '↓', ArrowUp: '↑', Escape: 'Escape' };

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXTUAL.has((el.type || '').toLowerCase());
}
const isPicked = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && PICKED.has((el.type || '').toLowerCase());
const isToggle = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
/** A field that offers a list to choose from as you type (a WAI-ARIA combobox, or an input with a datalist). */
const isCombobox = (el: Element) => el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || (el instanceof HTMLInputElement && !!el.list);

/** What an option is called: its label, else its text. */
const optionName = (o: HTMLOptionElement) => collapse(o.label || o.text, 80);

/** The element an event happened on, also inside an open shadow root (where the page sees only the root's host). */
function targetOf(e: Event): Element | null {
  const t = e.composedPath()[0] ?? e.target;
  return t instanceof Element ? t : null;
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

  constructor(private emit: Emit) {
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('input', this.onInput, true);
    document.addEventListener('change', this.onChange, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('blur', this.onBlur, true);
    document.addEventListener('focusin', this.onFocus, true);
  }

  setOn(on: boolean): void {
    if (!on) this.flushAll();
    this.on = on;
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
    // A label passes its click on to its control, and the control's own step says what happened.
    if (el instanceof HTMLLabelElement && el.control && (isTextField(el.control) || el.control instanceof HTMLSelectElement || isPicked(el.control) || isToggle(el.control))) return;
    const loc = buildLocator(el);
    this.emit({ kind: 'click', locator: loc.code, description: `Click ${loc.description}` });
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
    else if (isPicked(el)) {
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
    if (!this.on) return;
    if (KEY_NAME[e.key]) {
      // Choosing from a combobox's list with the keyboard: what was typed, then each key.
      const el = targetOf(e);
      if (!el || !isCombobox(el)) return;
      if (this.pendingFill.has(el)) this.flush(el);
      const loc = buildLocator(el);
      this.emit({ kind: 'press', locator: loc.code, key: e.key, description: `Press ${KEY_NAME[e.key]} in ${loc.description}` });
      return;
    }
    if (e.key !== 'Enter') return;
    this.submits.keydown(e);
    const el = targetOf(e);
    if (!el || !isField(el)) return;
    if (this.pendingFill.has(el)) this.flush(el);
    const loc = buildLocator(el);
    this.emit({ kind: 'press', locator: loc.code, key: 'Enter', description: `Press Enter in ${loc.description}` });
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
      // A rich text editor: its text as a whole, as fill puts it back (any card number or key in it masked).
      const loc = buildLocator(editor);
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
