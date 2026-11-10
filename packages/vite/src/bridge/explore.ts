/**
 * What Autopilot sees of the page: where it is, what it says, and what can be done on it. Each control comes with
 * the Playwright locator the recorder would write for it, so the step Autopilot takes is replayed, recorded and
 * saved as a test exactly like a person's.
 */
import { maskSecrets, redactUrl, SRC_ATTR, type ControlAbout, type PageControl, type PageSnapshot } from '../protocol';
import { accessibleName, annotatedAncestor, collapse, fieldValue, isField, isSecretField, isVisible, publicText, roleOf, screenText, visibleText } from './dom';
import { takeBlocked } from './guard';
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

/** The names of the icons a control shows: an svg `<use>`'s id, an icon element's classes and label. */
function iconWords(el: Element): string {
  const out: string[] = [];
  for (const icon of Array.from(el.querySelectorAll('svg, i, [class*="icon"], img')).slice(0, 4)) {
    const use = icon.querySelector('use');
    const ref = use?.getAttribute('href') ?? use?.getAttribute('xlink:href');
    if (ref) out.push(ref.replace(/^.*#/, ''));
    const cls = icon.getAttribute('class');
    if (cls) out.push(cls);
    for (const a of ['aria-label', 'title', 'alt', 'data-icon', 'name']) {
      const v = icon.getAttribute(a);
      if (v) out.push(v);
    }
    const title = icon.querySelector('title')?.textContent;
    if (title) out.push(title);
  }
  return out.join(' ');
}

/** What a control is beyond its name: Autopilot judges this before it uses it (risk.ts, the studio's shared/autopilot.ts). */
function aboutOf(el: Element, name: string): ControlAbout | undefined {
  const about: ControlAbout = {};
  const words = [el.getAttribute('title'), el.getAttribute('aria-label'), el instanceof HTMLInputElement && ['submit', 'button'].includes(el.type) ? el.value : null, iconWords(el)].filter(Boolean).join(' ');
  if (words) about.words = collapse(words, 200);
  const classes = [el.getAttribute('class'), el.getAttribute('data-variant'), el.getAttribute('variant'), el.getAttribute('data-color')].filter(Boolean).join(' ');
  if (classes) about.classes = collapse(classes, 200);
  const method = el.getAttribute('data-method') ?? el.getAttribute('data-turbo-method');
  if (method) about.method = method.toLowerCase();
  if (el.hasAttribute('data-confirm') || el.hasAttribute('data-turbo-confirm')) about.confirms = true;
  if (el instanceof HTMLAnchorElement && el.getAttribute('href')) about.href = redactUrl(el.href);
  const submit = (el instanceof HTMLButtonElement && el.type === 'submit') || (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image'));
  // A submit button's form, or the form a field sends when Enter is pressed in it.
  const form = submit || (el instanceof HTMLInputElement && submitsOf(el)) ? (el as HTMLButtonElement).form : null;
  if (form) {
    const override = (form.querySelector('input[name="_method"]') as HTMLInputElement | null)?.value;
    const action = el.getAttribute('formaction') || form.getAttribute('action') || location.href;
    about.form = { action: redactUrl(new URL(action, location.href).href), method: (override || el.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase() };
  }
  // An icon-only control: what its row or card is about tells what it acts on.
  if (!name || name.length < 2) {
    const row = el.closest('tr, li, [role="row"], [role="listitem"], article, [class*="card"], [class*="row"], [class*="item"]');
    if (row) about.context = collapse(maskSecrets(publicText(row)), 100);
  }
  const dialog = el.closest('dialog, [role="dialog"], [role="alertdialog"]');
  if (dialog) about.dialog = { alert: dialog.getAttribute('role') === 'alertdialog', text: collapse(maskSecrets(publicText(dialog)), 200) };
  return Object.keys(about).length ? about : undefined;
}

function control(el: Element, offscreen: boolean): PageControl {
  const role = roleOf(el) ?? el.tagName.toLowerCase();
  const name = collapse(accessibleName(el) || visibleText(el) || el.getAttribute('placeholder') || el.getAttribute('title'), 60);
  const src = el.getAttribute(SRC_ATTR) ?? annotatedAncestor(el)?.getAttribute(SRC_ATTR) ?? null;
  const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  const submits = submitsOf(el);
  const about = aboutOf(el, name);
  return { locator: buildLocator(el, { cheap: true }).code, role, name, ...(isField(el) ? { field: fieldOf(el) } : {}), ...(submits ? { submits } : {}), disabled, offscreen, src, ...(about ? { about } : {}) };
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
    blocked: takeBlocked(),
  };
}
