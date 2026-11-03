/**
 * Playwright locators for elements of the app, as a careful tester writes them: by test id, role and name, label or
 * text; a control that is on every card or row ("Add to cart" six times) by the card it is in. Never by where it is
 * written in the code: that is only known to the dev server, and moves with every edit above it.
 */
import { jsString as q, type LocatorInfo } from '../protocol';
import { accessibleName, collapse, isField, labelText, roleOf, visibleText } from './dom';

/** Values like "$78.40", "12", "−$19.60" change when the code changes, so they make poor locators. */
function looksVolatile(s: string): boolean {
  return /^[\s$€£¥+\-−–.,:%0-9()]*$/.test(s) || /\d/.test(s) && s.length <= 12;
}

export const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
  link: 'a[href], [role="link"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], textarea, [role="textbox"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  radio: 'input[type="radio"], [role="radio"]',
  combobox: 'select, [role="combobox"]',
  tab: '[role="tab"]',
  menuitem: '[role="menuitem"]',
  // What holds one of several identical controls: a product's card, a row, an item of a list.
  article: 'article, [role="article"]',
  listitem: 'li, [role="listitem"]',
  row: 'tr, [role="row"]',
  group: 'fieldset, details, [role="group"]',
  region: 'section[aria-label], section[aria-labelledby], [role="region"]',
  dialog: 'dialog, [role="dialog"]',
};

const CONTAINERS = new Set(['article', 'listitem', 'row', 'group', 'region', 'dialog']);

/** Roles a control is found by with its name (a container's name isn't its text). */
const named = (role: string | null): role is string => !!role && !!ROLE_SELECTORS[role] && !CONTAINERS.has(role);

/** An element's role as getByRole finds it, the containers above included. */
export function roleFor(el: Element): string | null {
  const role = roleOf(el);
  if (role) return role;
  switch (el.tagName.toLowerCase()) {
    case 'article':
      return 'article';
    case 'tr':
      return 'row';
    case 'fieldset':
    case 'details':
      return 'group';
    case 'section':
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    default:
      return null;
  }
}

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase();

/** The elements of this role (with this name, when given) in `scope`, as getByRole matches them. */
function byRole(scope: ParentNode, role: string, name: string | null, exact: boolean, limit = Infinity): Element[] {
  const sel = ROLE_SELECTORS[role] ?? `[role="${role}"]`;
  const needle = squash(name);
  const out: Element[] = [];
  const all = scope.querySelectorAll(sel);
  for (let i = 0; i < all.length && out.length < limit; i++) {
    const el = all[i];
    // The name comes from these (or a label, for fields): if none holds the words, it can't match. Costs nothing on a page of thousands.
    if (name !== null && !isField(el) && !(el instanceof HTMLImageElement) && !el.hasAttribute('aria-labelledby') && !squash(el.textContent).includes(needle) && !squash(el.getAttribute('aria-label')).includes(needle) && !squash(el.getAttribute('title')).includes(needle)) continue;
    if (roleFor(el) !== role) continue;
    if (name !== null) {
      const an = accessibleName(el);
      if (!(exact ? an === name : an.toLowerCase().includes(name.toLowerCase()))) continue;
    }
    out.push(el);
  }
  return out;
}

/**
 * How many elements of this role have this name: 0, 1, or 2 meaning "more than one" (all a locator needs to know).
 * Clicking through a list of "Add to cart" buttons asks the same question again and again: a second's memory is enough.
 */
const counted = new Map<string, { at: number; n: number }>();

function countByRoleAndName(role: string, name: string, exact: boolean): number {
  const key = `${role}\n${exact ? 1 : 0}\n${name}`;
  const now = performance.now();
  const hit = counted.get(key);
  if (hit && now - hit.at < 1000) return hit.n;
  if (counted.size > 200) counted.clear();
  const n = byRole(document, role, name, exact, 2).length;
  counted.set(key, { at: now, n });
  return n;
}

/** Innermost elements in `scope` whose own text is exactly `text`. */
function byText(scope: ParentNode, text: string): Element[] {
  const out: Element[] = [];
  const all = scope.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    if (collapse(el.innerText ?? '', 200) === text && !Array.from(el.children).some((c) => collapse((c as HTMLElement).innerText ?? '', 200) === text)) out.push(el);
  }
  return out;
}

function describeRole(role: string, name: string): string {
  const noun: Record<string, string> = { button: 'button', link: 'link', heading: 'heading', textbox: 'field', checkbox: 'checkbox', radio: 'option', combobox: 'menu', tab: 'tab' };
  return `the “${name}” ${noun[role] ?? role}`;
}

/** A class that names what something is ("product", "line-item"), not how it looks ("flex", "p-4") or a build's hash. */
function namingClass(el: Element): string | null {
  for (const c of Array.from(el.classList)) {
    if (/^[a-z][a-z-]{2,30}$/i.test(c) && !/--|^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|container|row|col|clearfix|active|selected|open|disabled|dark|light|sr-only)$|^(?:p|m|w|h|text|bg|border|rounded|shadow|gap|space|items|justify|self|place|overflow|opacity|font|leading|tracking|min|max|ring|transition|duration|ease|cursor|select|pointer|z|top|left|right|bottom|inset|truncate|whitespace|break|shrink|grow|basis|order)-/.test(c)) return c;
  }
  return null;
}

/** What finds a control again inside a container: the same ways as on the page, but only needing to be unique in there. */
interface Inner {
  /** The locator's calls after `page.` ("getByRole('button', { name: 'Add to cart' })"). */
  code: string;
  /** How a person names it: “Add to cart”. */
  words: string;
  count(scope: ParentNode): number;
}

function inners(el: Element): Inner[] {
  const out: Inner[] = [];
  const testId = el.getAttribute('data-testid');
  if (testId) out.push({ code: `getByTestId(${q(testId)})`, words: testId, count: (s) => s.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length });
  const role = roleFor(el);
  const name = named(role) ? accessibleName(el) : '';
  if (role && name && !looksVolatile(name) && name.length <= 60) {
    out.push({ code: `getByRole(${q(role)}, { name: ${q(name)} })`, words: `“${name}”`, count: (s) => byRole(s, role, name, false, 2).length });
    out.push({ code: `getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, words: `“${name}”`, count: (s) => byRole(s, role, name, true, 2).length });
  }
  if (isField(el)) {
    const label = labelText(el);
    if (label) out.push({ code: `getByLabel(${q(label)})`, words: `the “${label}” field`, count: (s) => Array.from(s.querySelectorAll('input, textarea, select')).filter((f) => labelText(f) === label).length });
    const ph = el.getAttribute('placeholder');
    if (ph) out.push({ code: `getByPlaceholder(${q(ph)})`, words: `the “${ph}” field`, count: (s) => s.querySelectorAll(`[placeholder="${CSS.escape(ph)}"]`).length });
  }
  const text = visibleText(el);
  if (!isField(el) && text && !looksVolatile(text) && text.length <= 40) out.push({ code: `getByText(${q(text)}, { exact: true })`, words: `“${text}”`, count: (s) => byText(s, text).length });
  const tag = el.tagName.toLowerCase();
  const cls = namingClass(el);
  if (cls) out.push({ code: `locator(${q(`${tag}.${cls}`)})`, words: `the ${cls.replace(/[-_]/g, ' ')}`, count: (s) => s.querySelectorAll(`${tag}.${CSS.escape(cls)}`).length });
  return out;
}

/** A container, as a locator, and the elements that locator finds on the page. */
function boxOf(node: Element): { code: string; all: () => Element[] } | null {
  const testId = node.getAttribute('data-testid');
  if (testId) return { code: `page.getByTestId(${q(testId)})`, all: () => Array.from(document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`)) };
  const role = roleFor(node);
  if (role && CONTAINERS.has(role)) return { code: `page.getByRole(${q(role)})`, all: () => byRole(document, role, null, false) };
  const cls = namingClass(node);
  if (cls) return { code: `page.locator(${q(`.${cls}`)})`, all: () => Array.from(document.querySelectorAll(`.${CSS.escape(cls)}`)) };
  return null;
}

/** What names a card or a row: its heading, its first bold words or label, else its first words; never a price or a count. */
function titleOf(node: Element, inside: Element | null): string | null {
  const words = (el: Element): string | null => {
    if (inside && (inside.contains(el) || el.contains(inside))) return null;
    const t = collapse((el as HTMLElement).innerText ?? el.textContent, 200);
    // A shorter piece of it still finds the card (hasText matches part of its text).
    return t && !looksVolatile(t) ? (t.length <= 40 ? t : t.slice(0, 40).replace(/\s+\S*$/, '')) : null;
  };
  for (const sel of ['h1, h2, h3, h4, h5, h6, [role="heading"]', 'b, strong, dt, th, label, legend, figcaption, caption']) {
    for (const el of Array.from(node.querySelectorAll(sel))) {
      const t = words(el);
      if (t) return t;
    }
  }
  for (const el of Array.from(node.querySelectorAll('*'))) {
    if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) continue;
    const t = words(el);
    if (t) return t;
  }
  const aria = node.getAttribute('aria-label');
  return aria && !looksVolatile(aria) ? collapse(aria, 40) : null;
}

/** Enough levels to reach a card or a row from a control in it. */
const SCOPE_LEVELS = 6;

/**
 * Of several controls that are the same ("Add to cart" on every product), this one: by the nearest container that
 * holds only it and that its title tells apart from the others ("Celadon mug, 12 oz"). A card or a row is found by
 * its own title the same way.
 */
function scoped(el: Element): LocatorInfo | null {
  const ways = inners(el);
  const text = visibleText(el);
  // The element itself is the card or the row.
  const own = named(roleFor(el)) ? null : boxOf(el);
  const ownTitle = own && titleOf(el, null);
  if (own && ownTitle && own.all().filter((c) => matchesText(c, ownTitle)).length === 1) {
    return { code: `${own.code}.filter({ hasText: ${q(ownTitle)} })`, description: `“${ownTitle}”`, text, within: ownTitle };
  }
  let node = el.parentElement;
  for (let level = 0; node && node !== document.body && level < SCOPE_LEVELS; level++, node = node.parentElement) {
    const way = ways.find((w) => w.count(node!) === 1);
    if (!way) break; // more than one in here: further out holds more still
    const box = boxOf(node);
    const title = box && titleOf(node, el);
    if (!box || !title) continue;
    const same = box.all().filter((c) => matchesText(c, title));
    if (same.length !== 1 || same[0] !== node) continue;
    return { code: `${box.code}.filter({ hasText: ${q(title)} }).${way.code}`, description: `${way.words} for “${title}”`, text, within: title };
  }
  return null;
}

/** Playwright's hasText: the text somewhere inside, ignoring case and spacing. */
function matchesText(el: Element, text: string): boolean {
  return collapse(el.textContent, 100_000).toLowerCase().includes(collapse(text, 200).toLowerCase());
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** The last resort: which of the same it is, counting from the top of the page. */
function nth(el: Element): LocatorInfo {
  const text = visibleText(el);
  const role = roleFor(el);
  const name = named(role) ? accessibleName(el) : '';
  const tag = el.tagName.toLowerCase();
  const cls = namingClass(el);
  const pick = (code: string, all: Element[], words: string): LocatorInfo => {
    const i = Math.max(0, all.indexOf(el));
    return all.length > 1 ? { code: `${code}.nth(${i})`, description: `the ${ordinal(i + 1)} ${words}`, text } : { code, description: words, text };
  };
  if (role && name && !looksVolatile(name) && name.length <= 60) return pick(`page.getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, byRole(document, role, name, true), describeRole(role, name).replace(/^the /, ''));
  const css = cls ? `${tag}.${cls}` : tag;
  return pick(`page.locator(${q(css)})`, Array.from(document.querySelectorAll(cls ? `${tag}.${CSS.escape(cls)}` : tag)), cls ? cls.replace(/[-_]/g, ' ') : tag);
}

/**
 * A locator from what was known about an element that is gone now (nothing
 * left to count matches against): its role and name, else its text.
 */
export function locatorFromInfo(role: string | null, label: string, text: string, tag: string): LocatorInfo {
  const name = collapse(label || text, 60);
  if (role && ROLE_SELECTORS[role] && name && !looksVolatile(name)) return { code: `page.getByRole(${q(role)}, { name: ${q(name)} })`, description: describeRole(role, name), text };
  if (text && !looksVolatile(text) && text.length <= 40) return { code: `page.getByText(${q(text)}, { exact: true })`, description: `“${text}”`, text };
  return { code: `page.locator(${q(tag)}).first()`, description: name ? `the “${name.slice(0, 40)}” ${tag}` : tag, text };
}

/**
 * Build the most stable Playwright locator we can for `el`, in the order a
 * careful tester would: test id, role + accessible name, label, placeholder,
 * exact text; then the same inside the card or row that tells it apart; and
 * last, which of the same it is.
 */
export function buildLocator(el: Element, opts: { cheap?: boolean } = {}): LocatorInfo {
  const text = visibleText(el);

  const testId = el.getAttribute('data-testid');
  if (testId && document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length === 1) {
    // Name it the way a person would: its label, or its text without the values that change.
    const name = collapse((accessibleName(el) || text).replace(/[-−–+]?\s?[$€£¥]?\s?\d[\d.,]*%?/g, ' '), 30);
    return { code: `page.getByTestId(${q(testId)})`, description: name && !looksVolatile(name) ? `“${name}” (${testId})` : testId, text };
  }

  const role = roleFor(el);
  if (named(role)) {
    const name = accessibleName(el);
    if (name && !looksVolatile(name) && name.length <= 60) {
      if (countByRoleAndName(role, name, false) === 1) {
        return { code: `page.getByRole(${q(role)}, { name: ${q(name)} })`, description: describeRole(role, name), text };
      }
      if (countByRoleAndName(role, name, true) === 1) {
        return { code: `page.getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, description: describeRole(role, name), text };
      }
    }
  }

  if (isField(el)) {
    const label = labelText(el);
    if (label && Array.from(document.querySelectorAll('input, textarea, select')).filter((f) => labelText(f) === label).length === 1) return { code: `page.getByLabel(${q(label)})`, description: `the “${label}” field`, text };
    const ph = el.getAttribute('placeholder');
    if (ph && document.querySelectorAll(`[placeholder="${CSS.escape(ph)}"]`).length === 1) return { code: `page.getByPlaceholder(${q(ph)})`, description: `the “${ph}” field`, text };
  }

  // Counting matches by text walks the whole page: skipped when the caller can't afford it on a large page.
  const affordable = !opts.cheap || document.getElementsByTagName('*').length < 2500;
  if (affordable && text && !looksVolatile(text) && text.length <= 40 && byText(document.body, text).length === 1) {
    return { code: `page.getByText(${q(text)}, { exact: true })`, description: `“${text}”`, text };
  }

  return scoped(el) ?? nth(el);
}
