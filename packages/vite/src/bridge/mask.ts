/**
 * While a session records, the screen it shares shows every secret field as dots and blurs what is marked private:
 * its screenshots and video are pictures of the screen, so this is what keeps a card number, a one-time code or a
 * key out of them, as the recorded text keeps it out of the events. The same rules decide what is secret (see dom.ts).
 */
import { isField, isSecretField, PRIVATE } from './dom';

const ATTR = 'data-saywright-masked';
const STYLE_ID = 'saywright-mask';

let observer: MutationObserver | null = null;

function mark(el: Element): void {
  if (isField(el) && !(el instanceof HTMLSelectElement) && isSecretField(el)) el.setAttribute(ATTR, '');
}

function scan(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll('input, textarea'))) mark(el);
}

/** A field can become secret as it is used: a card number typed into one, a password shown as text. */
const onUse = (e: Event): void => {
  if (e.target instanceof Element) mark(e.target);
};

export function maskScreen(on: boolean): void {
  if (typeof document === 'undefined') return;
  if (!on) {
    observer?.disconnect();
    observer = null;
    removeEventListener('input', onUse, true);
    removeEventListener('focusin', onUse, true);
    document.getElementById(STYLE_ID)?.remove();
    for (const el of Array.from(document.querySelectorAll(`[${ATTR}]`))) el.removeAttribute(ATTR);
    return;
  }
  if (observer) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  const marked = PRIVATE.split(',')
    .map((s) => `${s.trim()}:not(input):not(textarea)`)
    .join(',');
  style.textContent = `[${ATTR}]{-webkit-text-security:disc!important}${marked}{filter:blur(6px)!important}`;
  document.documentElement.appendChild(style);
  scan(document);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target instanceof Element) mark(r.target);
        continue;
      }
      for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof Element)) continue;
        mark(n);
        scan(n);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder', 'inputmode'] });
  addEventListener('input', onUse, true);
  addEventListener('focusin', onUse, true);
}
