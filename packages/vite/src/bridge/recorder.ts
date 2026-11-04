import { MASK, maskSecrets, type RecordedAction } from '../protocol';
import { collapse, isField, isSecretField, secretNameOf } from './dom';
import { EnterSubmits } from './forms';
import { buildLocator } from './locator';

type Emit = (action: RecordedAction) => void;

const INTERACTIVE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], input, select, textarea, summary, label';
const TEXTUAL = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', '']);

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXTUAL.has((el.type || '').toLowerCase());
}

/** What an option is called: its label, else its text. */
const optionName = (o: HTMLOptionElement) => collapse(o.label || o.text, 80);

/**
 * Records what the user does in the app as Playwright steps: clicks, text
 * entry (one `fill` per field, flushed on change, blur or Enter), choices in
 * lists (every option chosen, in a list that takes several) and Enter. A
 * secret (a password, a card number…) is recorded by its name alone: what was
 * typed never leaves the page.
 */
export class Recorder {
  private on = false;
  private pendingFill = new Map<Element, ReturnType<typeof setTimeout>>();
  private submits = new EnterSubmits();

  constructor(private emit: Emit) {
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

  private onFocus = (e: FocusEvent) => {
    // A password field is remembered as one before anything is typed, should “show password” make it a text field.
    if (this.on && e.target instanceof Element && isField(e.target)) isSecretField(e.target);
  };

  private onClick = (e: Event) => {
    if (!this.on) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const el = t.closest(INTERACTIVE) ?? t;
    if (isTextField(el)) return; // focusing a field is implied by `fill`
    if (el instanceof HTMLSelectElement || el instanceof HTMLOptionElement) return; // the choice is the step
    if (this.submits.isSubmitClick(e as MouseEvent, el)) return; // the Enter step already submits the form
    if (el instanceof HTMLLabelElement && el.control && (isTextField(el.control) || el.control instanceof HTMLSelectElement)) return;
    const loc = buildLocator(el);
    this.emit({ kind: 'click', locator: loc.code, description: `Click ${loc.description}` });
  };

  private onInput = (e: Event) => {
    if (!this.on) return;
    const el = e.target;
    if (!(el instanceof Element) || !isTextField(el)) return;
    const prev = this.pendingFill.get(el);
    if (prev) clearTimeout(prev);
    this.pendingFill.set(el, setTimeout(() => this.flush(el), 1200));
  };

  private onChange = (e: Event) => {
    if (!this.on) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (isTextField(el)) this.flush(el);
    else if (el instanceof HTMLSelectElement) {
      const loc = buildLocator(el);
      const chosen = Array.from(el.selectedOptions);
      const names = chosen.map(optionName);
      const said = names.length ? names.map((n) => `“${n}”`).join(', ') : 'nothing';
      this.emit({
        kind: 'fill',
        locator: loc.code,
        value: chosen[0]?.value ?? '',
        select: names,
        values: chosen.map((o) => o.value),
        description: `Choose ${said} in ${loc.description}`,
      });
    }
  };

  private onBlur = (e: Event) => {
    if (!this.on) return;
    const el = e.target;
    if (el instanceof Element && this.pendingFill.has(el)) this.flush(el);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.on || e.key !== 'Enter') return;
    this.submits.keydown(e);
    const el = e.target;
    if (!(el instanceof Element) || !isField(el)) return;
    if (this.pendingFill.has(el)) this.flush(el);
    const loc = buildLocator(el);
    this.emit({ kind: 'press', locator: loc.code, key: 'Enter', description: `Press Enter in ${loc.description}` });
  };

  private flush(el: Element): void {
    const t = this.pendingFill.get(el);
    if (t) clearTimeout(t);
    if (!this.pendingFill.delete(el)) return;
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
