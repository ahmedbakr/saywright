import type { RecordedAction } from '../protocol';
import { isField } from './dom';
import { EnterSubmits } from './forms';
import { buildLocator } from './locator';

type Emit = (action: RecordedAction) => void;

const INTERACTIVE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], input, select, textarea, summary, label';
const TEXTUAL = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', '']);

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXTUAL.has((el.type || '').toLowerCase());
}

/**
 * Records what the user does in the app as Playwright steps: clicks, text
 * entry (one `fill` per field, flushed on change, blur or Enter) and Enter.
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
  }

  setOn(on: boolean): void {
    if (!on) this.flushAll();
    this.on = on;
  }

  private onClick = (e: Event) => {
    if (!this.on) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const el = t.closest(INTERACTIVE) ?? t;
    if (isTextField(el)) return; // focusing a field is implied by `fill`
    if (this.submits.isSubmitClick(e as MouseEvent, el)) return; // the Enter step already submits the form
    if (el instanceof HTMLLabelElement && el.control && isTextField(el.control)) return;
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
      this.emit({ kind: 'fill', locator: loc.code, value: el.value, description: `Choose “${el.value}” in ${loc.description}` });
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
    this.emit({ kind: 'fill', locator: loc.code, value: el.value, description: `Type “${el.value}” into ${loc.description}` });
  }

  private flushAll(): void {
    for (const el of Array.from(this.pendingFill.keys())) this.flush(el);
  }
}
