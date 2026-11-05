/**
 * What Autopilot sees of the page: where it is, what it says, and what can be done on it. Each control comes with
 * the Playwright locator the recorder would write for it, so the step Autopilot takes is replayed, recorded and
 * saved as a test exactly like a person's.
 */
import { maskSecrets, redactUrl, SRC_ATTR, type PageControl, type PageSnapshot } from '../protocol';
import { accessibleName, annotatedAncestor, collapse, fieldValue, isField, isSecretField, isVisible, publicText, roleOf, screenText, visibleText } from './dom';
import { buildLocator } from './locator';

const CONTROLS =
  'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"]';
/** Enough to act on any page; more would cost the AI tokens without helping it choose. */
const MAX_CONTROLS = 60;
const MAX_TEXT = 1500;

function fieldOf(el: Element): PageControl['field'] | undefined {
  if (!isField(el)) return undefined;
  if (el instanceof HTMLSelectElement) {
    return { type: 'select', value: el.selectedOptions[0]?.text.trim() ?? '', required: el.required, options: Array.from(el.options, (o) => collapse(o.text, 40)).slice(0, 15) };
  }
  const type = el instanceof HTMLTextAreaElement ? 'textarea' : el.type || 'text';
  if (type === 'checkbox' || type === 'radio') return { type, value: '', required: el.required, checked: (el as HTMLInputElement).checked };
  // A secret (a password, a card number, a key) only as dots: it is never sent to an AI.
  return { type, value: collapse(fieldValue(el), 60), required: el.required, ...(isSecretField(el) ? { secret: true } : {}) };
}

/** What pressing Enter in a field sends its form with: the form's default button (its first submit button), else the form's own name. */
function submitsOf(el: Element): string | undefined {
  if (!(el instanceof HTMLInputElement) || ['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(el.type)) return undefined;
  const form = el.form;
  if (!form) return undefined;
  const button = form.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
  const name = button ? accessibleName(button) || visibleText(button) || (button as HTMLInputElement).value : accessibleName(form);
  return collapse(name, 60) || undefined;
}

function control(el: Element, offscreen: boolean): PageControl {
  const role = roleOf(el) ?? el.tagName.toLowerCase();
  const name = collapse(accessibleName(el) || visibleText(el) || el.getAttribute('placeholder') || el.getAttribute('title'), 60);
  const src = el.getAttribute(SRC_ATTR) ?? annotatedAncestor(el)?.getAttribute(SRC_ATTR) ?? null;
  const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  const submits = submitsOf(el);
  return { locator: buildLocator(el, { cheap: true }).code, role, name, ...(isField(el) ? { field: fieldOf(el) } : {}), ...(submits ? { submits } : {}), disabled, offscreen, src };
}

export function snapshot(): PageSnapshot {
  const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')).filter(isVisible);
  const dialog = dialogs[dialogs.length - 1] ?? null;
  const scope = dialog ?? document.body;
  const usable = Array.from(scope.querySelectorAll(CONTROLS)).filter((el) => !el.closest('saywright-recorder, [aria-hidden="true"], [inert]') && isVisible(el));
  // What is on screen first, then the rest of the page from the top.
  const placed = usable.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, top: r.top, left: r.left, offscreen: r.bottom < 0 || r.top > innerHeight };
  });
  placed.sort((a, b) => Number(a.offscreen) - Number(b.offscreen) || a.top - b.top || a.left - b.left);
  const main = dialog ?? document.querySelector('main') ?? document.body;
  const listed = placed.slice(0, MAX_CONTROLS);
  // Where a key press goes: the control the last step left the focus on.
  const focused = listed.findIndex((p) => p.el === document.activeElement);
  return {
    url: redactUrl(location.href),
    title: document.title,
    headings: Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(isVisible)
      .slice(0, 12)
      .map((h) => collapse(publicText(h), 100)),
    text: collapse(maskSecrets(screenText(main as HTMLElement)), MAX_TEXT),
    controls: listed.map((p) => control(p.el, p.offscreen)),
    more: Math.max(0, placed.length - MAX_CONTROLS),
    dialog: dialog ? collapse(accessibleName(dialog) || dialog.querySelector('h1, h2, h3')?.textContent, 80) || 'a dialog' : null,
    viewport: [innerWidth, innerHeight],
    focused: focused >= 0 ? focused : null,
  };
}
