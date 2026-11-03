/**
 * Forms, as a person used them. Enter in a field submits its form, and the browser then "clicks" the form's submit
 * button itself (implicit submission). That click is the browser's, not the person's: the recorders keep the Enter
 * and leave the click out, or a test would press Enter (which submits) and then wait for a button that may be gone.
 */
import { collapse, isField, labelText } from './dom';

/** What decides whether a click is the browser submitting a form after Enter. */
export interface ClickFacts {
  /** MouseEvent.detail: 0 when no pointer made the click (a key, a script, or the browser submitting a form). */
  detail: number;
  /** The clicked element submits its form (a submit button, or an input of type submit or image). */
  submits: boolean;
  /** It belongs to the form Enter was last pressed in. */
  sameForm: boolean;
  /** Milliseconds since that Enter. */
  sinceEnter: number;
}

/** The browser follows Enter with that click at once (well under a millisecond in Chromium). */
const WINDOW_MS = 1000;

export function isEnterSubmitClick(c: ClickFacts): boolean {
  return c.detail === 0 && c.submits && c.sameForm && c.sinceEnter >= 0 && c.sinceEnter < WINDOW_MS;
}

/** Remembers the last Enter pressed in a form's field, to recognise the click the browser makes after it. */
export class EnterSubmits {
  private last: { form: HTMLFormElement; at: number } | null = null;

  keydown(e: KeyboardEvent): void {
    const el = e.target;
    if (e.key === 'Enter' && !e.isComposing && el instanceof HTMLInputElement && el.form) this.last = { form: el.form, at: e.timeStamp };
  }

  /** Whether this click on `el` is the browser submitting the form an Enter was just pressed in. */
  isSubmitClick(e: MouseEvent, el: Element): boolean {
    const last = this.last;
    if (!last) return false;
    const control = el.closest('button, input[type="submit"], input[type="image"]') as HTMLButtonElement | HTMLInputElement | null;
    return isEnterSubmitClick({
      detail: e.detail,
      submits: !!control && (control.type === 'submit' || control.type === 'image'),
      sameForm: control?.form === last.form,
      sinceEnter: e.timeStamp - last.at,
    });
  }
}

/** A form's name: its own label, else its fields' labels (its text runs labels and button words together: “CouponApply”). */
export function formLabel(form: HTMLFormElement): string {
  const own = form.getAttribute('aria-label') || form.getAttribute('title');
  if (own) return collapse(own, 60);
  const fields = Array.from(form.elements).filter((el) => isField(el) && !(el instanceof HTMLInputElement && el.type === 'hidden'));
  return collapse(fields.map((el) => labelText(el) || el.getAttribute('placeholder') || el.getAttribute('name') || '').filter(Boolean).join(' · '), 60);
}
