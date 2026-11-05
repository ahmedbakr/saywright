import { isField } from './dom';
import { scriptedInput } from './own';

const CLICKABLE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], input, select, textarea, label, summary, [tabindex]';

/** The element a click at (x, y) should activate. */
function clickTargetAt(x: number, y: number): Element | null {
  const top = document.elementFromPoint(x, y);
  if (!top) return null;
  return top.closest(CLICKABLE) ?? top;
}

let lastField: HTMLInputElement | HTMLTextAreaElement | null = null;

export function clickAt(x: number, y: number): Element | null {
  const el = clickTargetAt(x, y);
  if (!el) return null;
  scriptedInput();
  if (el instanceof HTMLElement) {
    if (isField(el) && !(el instanceof HTMLSelectElement) && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((el as HTMLInputElement).type)) {
      el.focus();
      lastField = el as HTMLInputElement | HTMLTextAreaElement;
      return el;
    }
    el.focus({ preventScroll: true });
    el.click();
  }
  return el;
}

/** Set a field's value the way React expects (native setter + input event). */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function typeText(text: string, submit: boolean): Element | null {
  scriptedInput();
  const active = document.activeElement;
  const target =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active
      : lastField && lastField.isConnected
        ? lastField
        : null;
  if (!target) return null;
  target.focus();
  setNativeValue(target, text);
  if (submit) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    target.form?.requestSubmit();
  }
  return target;
}

function scrollableAncestor(el: Element | null): Element | null {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const canY = /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
    const canX = /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
    if (canY || canX) return n;
  }
  return null;
}

export function scrollAt(x: number, y: number, dx: number, dy: number): void {
  const target = scrollableAncestor(document.elementFromPoint(x, y));
  if (target) target.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  else window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
}
