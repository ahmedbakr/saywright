/**
 * Playwright locators for elements of the app, as a careful tester writes them: by test id, role and name, label or
 * text; a control that is on every card or row ("Add to cart" six times) by the card it is in. Never by where it is
 * written in the code: that is only known to the dev server, and moves with every edit above it.
 */
import { jsString as q, type LocatorInfo } from '../protocol';
import { accessibleName, collapse, deepAll, deepLists, editableOf, inPrivate, isField, labelText, NAMED_INSIDE, roleOf, shadowRoots, shownText, visibleText, writtenText } from './dom';

/**
 * A number that changes with the code or between loads: an amount, a share, a decimal, a count in brackets, a
 * number after #, or a long one (an id). A short label's number ("Row 3000", "Step 2", "Load in 2 s") is none of those:
 * it is part of the name.
 */
function changingNumber(s: string): boolean {
  return /[$€£¥%]/.test(s) || /\d[.,]\d/.test(s) || /\(\s*[+\-−]?\d+\s*\)/.test(s) || /#\s?\d/.test(s) || /\d{5,}/.test(s);
}

/** Values like "$78.40", "12", "−$19.60", "(3)" change when the code changes, so they make poor locators. */
function looksVolatile(s: string): boolean {
  return /^[\s$€£¥+\-−–.,:%0-9()#]*$/.test(s) || (/\d/.test(s) && s.length <= 12 && changingNumber(s));
}

/**
 * Words to find an element by with their numbers left open only when the numbers are of the kind that changes: a
 * label's own number is found exactly (the 3,000th row of a list is not its first).
 */
const openNumbers = (s: string): Pattern | null => (changingNumber(s) ? numbersOpen(s) : null);

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase();

/** Spaces as Playwright's text matching leaves them: a run is one, none at the ends, soft hyphens and zero-width spaces gone. */
const spaced = (s: string) => s.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');

/** A number as a page shows it: 12, 1,234.50, 3.5. */
const NUMBER = /\d[\d.,]*/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Words to find an element by, with its numbers left open: as a regular expression, and as a test writes it. */
export interface Pattern {
  re: RegExp;
  code: string;
  /** Its longest fixed part, squashed (see squash): what an element's text must have for it to match. */
  hint: string;
}

/**
 * A name or a text with numbers in it ("Pay $91.57 and subscribe", "Like this portfolio (1)") as a pattern with the
 * numbers left open, so a fix that changes a price or a count still finds it. Null without numbers, or when only
 * its numbers say what it is. With `spaces` 'any', the spaces are left open too: a pattern is tried on a text as the
 * page's markup has it, with the line breaks and the indentation around its words.
 */
export function numbersOpen(s: string, spaces: 'one' | 'any' = 'one'): Pattern | null {
  if (!/\d/.test(s) || s.length > 60 || s.endsWith('…')) return null;
  const parts = s.split(NUMBER);
  if (parts.join('').replace(/[^\p{L}]+/gu, '').length < 3) return null;
  const fixed = (part: string) => (spaces === 'any' ? escapeRe(part).replace(/ /g, '\\s+') : escapeRe(part));
  const body = parts.map(fixed).join('\\d[\\d.,]*');
  const source = spaces === 'any' ? `^\\s*${body}\\s*$` : `^${body}$`;
  const hint = parts.map(squash).sort((a, b) => b.length - a.length)[0] ?? '';
  return { re: new RegExp(source), code: `/${source}/`, hint };
}

/**
 * For a check, whether a way of finding the element by its words (a name, a text) still finds it once the fix makes
 * it show what it should: else the test can't pass however right the fix is ("Like (1)" should show "Like (2)").
 */
type Keep = (words: string | Pattern) => boolean;
const always: Keep = () => true;

/** What the element will show: the expected value in place of the part of its text shaped like it, else that value alone. */
function keeper(el: Element, expected: string): Keep {
  const now = visibleText(el);
  const shape = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+');
  const part = /\d/.test(expected) && shape !== expected ? new RegExp(shape).exec(now)?.[0] : undefined;
  // Already showing it (a check that passes now, to keep it so): it stays as it is. Showing it means showing that and
  // nothing else: “Inactive” does not show “active”, and will show “active” once fixed.
  const then = squash(now) === squash(expected) ? now : part ? now.replace(part, () => expected) : expected;
  // Without case: the words to find it by are the page's, and the screen may show them in capitals.
  return (w) => (typeof w === 'string' ? then.toLowerCase().includes(w.toLowerCase()) : new RegExp(w.re.source, 'i').test(then));
}

/** Whether its name is its own text (a button's words), not given apart from it (a label, aria-label). */
const namedByText = (el: Element) => !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !isField(el) && !(el instanceof HTMLImageElement);

export const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]',
  link: 'a[href], [role="link"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="url"], input[type="tel"], textarea, [role="textbox"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  radio: 'input[type="radio"], [role="radio"]',
  combobox: 'select, input[list], [role="combobox"]',
  listbox: 'select, [role="listbox"]',
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

/** Playwright's text matching: case-insensitive and partial (spaces collapsed), or exact. */
function sameWords(actual: string, wanted: string, exact: boolean): boolean {
  const a = actual.replace(/\s+/g, ' ').trim();
  const w = wanted.replace(/\s+/g, ' ').trim();
  return exact ? a === w : a.toLowerCase().includes(w.toLowerCase());
}

/** The elements of this role (with this name, when given) in `scope`, as getByRole matches them. */
function byRole(scope: ParentNode, role: string, name: string | Pattern | null, exact: boolean, limit = Infinity): Element[] {
  const sel = ROLE_SELECTORS[role] ?? `[role="${role}"]`;
  const needle = name === null ? '' : typeof name === 'string' ? squash(name) : name.hint;
  const out: Element[] = [];
  for (const all of deepLists(scope, sel)) {
    for (let i = 0; i < all.length && out.length < limit; i++) {
      const el = all[i];
      // The name comes from these (or a label, for fields; an image's alt or a part's label inside): if none holds the words, it can't match. Costs nothing on a page of thousands.
      if (name !== null && !isField(el) && !(el instanceof HTMLImageElement) && !el.hasAttribute('aria-labelledby') && !squash(el.textContent).includes(needle) && !squash(el.getAttribute('aria-label')).includes(needle) && !squash(el.getAttribute('title')).includes(needle) && !el.querySelector(NAMED_INSIDE)) continue;
      if (roleFor(el) !== role) continue;
      if (name !== null) {
        const an = accessibleName(el);
        if (!(typeof name !== 'string' ? name.re.test(an) : exact ? an === name : an.toLowerCase().includes(name.toLowerCase()))) continue;
      }
      out.push(el);
    }
  }
  return out;
}

/**
 * How many elements of this role have this name: 0, 1, or 2 meaning "more than one" (all a locator needs to know).
 * Clicking through a list of "Add to cart" buttons asks the same question again and again: a second's memory is enough.
 */
const counted = new Map<string, { at: number; n: number }>();

function countByRoleAndName(role: string, name: string | Pattern, exact: boolean): number {
  const key = `${role}\n${exact ? 1 : 0}\n${typeof name === 'string' ? name : name.code}`;
  const now = performance.now();
  const hit = counted.get(key);
  if (hit && now - hit.at < 1000) return hit.n;
  if (counted.size > 200) counted.clear();
  const n = byRole(document, role, name, exact, 2).length;
  counted.set(key, { at: now, n });
  return n;
}

/**
 * The elements in `scope` that getByText finds by these words (all of them, exactly) or by this pattern, as Playwright
 * finds them: by every text written in an element, shown or not (a pattern on it as it is written, spaces and all),
 * and only the innermost that holds it.
 */
function byText(scope: ParentNode, text: string | Pattern): Element[] {
  const read = new Map<Element | ShadowRoot, string>();
  const written = (part: Element | ShadowRoot): string => {
    let t = read.get(part);
    if (t === undefined) read.set(part, (t = writtenText(part, written)));
    return t;
  };
  const is = (part: Element | ShadowRoot): boolean => {
    const t = written(part);
    if (typeof text === 'string') return t.length >= text.length && spaced(t) === text;
    return squash(t).includes(text.hint) && text.re.test(t);
  };
  const out: Element[] = [];
  for (const all of deepLists(scope, '*')) {
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!is(el)) continue;
      let inside = !!el.shadowRoot && is(el.shadowRoot);
      for (let c = el.firstElementChild; c && !inside; c = c.nextElementSibling) inside = is(c);
      if (!inside) out.push(el);
    }
  }
  return out;
}

/** A way of finding an element by its own words, and how many elements in a scope are found that way. */
interface TextWay {
  code: string;
  count(scope: ParentNode): number;
}

/**
 * The ways getByText finds `el` by its own words, the one that outlives a changed number first: the words written in
 * the page, which are what Playwright reads (not the screen's: a style that shows capitals or breaks a line changes
 * nothing there), and only when they are the words the screen shows (`shown`), with nothing hidden among them.
 */
function textWays(el: Element, shown: string, keep: Keep): TextWay[] {
  if (!shown || shown.length > 40 || isField(el)) return [];
  const raw = writtenText(el);
  const words = spaced(raw);
  if (!words || squash(words) !== squash(spaced(shown))) return [];
  const out: TextWay[] = [];
  // With its numbers left open; with its spaces too, when the markup has more around the words than a pattern allows.
  const open = changingNumber(words) ? [numbersOpen(words), numbersOpen(words, 'any')].find((p) => p?.re.test(raw)) : null;
  if (open && keep(open)) out.push({ code: `getByText(${open.code})`, count: (s) => byText(s, open).length });
  if (!looksVolatile(words) && keep(words)) out.push({ code: `getByText(${q(words)}, { exact: true })`, count: (s) => byText(s, words).length });
  return out;
}

function describeRole(role: string, name: string): string {
  const noun: Record<string, string> = { button: 'button', link: 'link', heading: 'heading', textbox: 'field', checkbox: 'checkbox', radio: 'option', combobox: 'menu', listbox: 'list', tab: 'tab' };
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

/** A tag as a person names what it holds. */
const TAG_WORDS: Record<string, string> = { td: 'cell', th: 'heading', dd: 'value', li: 'item', span: 'text', p: 'text', strong: 'text', b: 'text', div: 'text', output: 'value', time: 'time', img: 'image' };

function inners(el: Element, keep: Keep): Inner[] {
  const out: Inner[] = [];
  const testId = el.getAttribute('data-testid');
  if (testId) out.push({ code: `getByTestId(${q(testId)})`, words: testId, count: (s) => deepAll(s, `[data-testid="${CSS.escape(testId)}"]`).length });
  const role = roleFor(el);
  const name = named(role) ? accessibleName(el) : '';
  const byName = !namedByText(el) || keep === always;
  if (role && name && name.length <= 60) {
    const open = openNumbers(name);
    if (open && (byName || keep(open))) out.push({ code: `getByRole(${q(role)}, { name: ${open.code} })`, words: `“${name}”`, count: (s) => byRole(s, role, open, false, 2).length });
    if (!looksVolatile(name) && (byName || keep(name))) {
      out.push({ code: `getByRole(${q(role)}, { name: ${q(name)} })`, words: `“${name}”`, count: (s) => byRole(s, role, name, false, 2).length });
      out.push({ code: `getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, words: `“${name}”`, count: (s) => byRole(s, role, name, true, 2).length });
    }
  }
  if (isField(el)) {
    const label = labelText(el);
    if (label) out.push({ code: `getByLabel(${q(label)})`, words: `the “${label}” field`, count: (s) => deepAll(s, 'input, textarea, select').filter((f) => labelText(f) === label).length });
    const ph = el.getAttribute('placeholder');
    if (ph) out.push({ code: `getByPlaceholder(${q(ph)})`, words: `the “${ph}” field`, count: (s) => deepAll(s, `[placeholder="${CSS.escape(ph)}"]`).length });
  }
  const text = shownText(el);
  if (!editableOf(el)) for (const way of textWays(el, text, keep)) out.push({ ...way, words: `“${text}”` });
  const tag = el.tagName.toLowerCase();
  const cls = namingClass(el);
  if (cls) out.push({ code: `locator(${q(`${tag}.${cls}`)})`, words: `the ${cls.replace(/[-_]/g, ' ')}`, count: (s) => deepAll(s, `${tag}.${CSS.escape(cls)}`).length });
  // Last, its kind alone, for the one of its kind in its card or row (the cell of a “You pay” row that holds the amount).
  out.push({ code: `locator(${q(tag)})`, words: `the ${TAG_WORDS[tag] ?? tag}`, count: (s) => deepAll(s, tag).length });
  return out;
}

/** A container, as a locator, and the elements that locator finds on the page. */
function boxOf(node: Element): { code: string; all: () => Element[] } | null {
  const testId = node.getAttribute('data-testid');
  if (testId) return { code: `page.getByTestId(${q(testId)})`, all: () => deepAll(document, `[data-testid="${CSS.escape(testId)}"]`) };
  const role = roleFor(node);
  if (role && CONTAINERS.has(role)) return { code: `page.getByRole(${q(role)})`, all: () => byRole(document, role, null, false) };
  const cls = namingClass(node);
  if (cls) return { code: `page.locator(${q(`.${cls}`)})`, all: () => deepAll(document, `.${CSS.escape(cls)}`) };
  return null;
}

/** What names a card or a row: its heading, its first bold words or label, else its first words; never a price or a count. */
function titleOf(node: Element, inside: Element | null): string | null {
  const words = (el: Element): string | null => {
    if (inside && (inside.contains(el) || el.contains(inside))) return null;
    // What a part marked private says is never written into a test.
    if (inPrivate(el)) return null;
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
function scoped(el: Element, keep: Keep): LocatorInfo | null {
  const ways = inners(el, keep);
  const text = shownText(el);
  // The element itself is the card or the row.
  const own = named(roleFor(el)) ? null : boxOf(el);
  const ownTitle = own && titleOf(el, null);
  if (own && ownTitle && keep(ownTitle) && own.all().filter((c) => matchesText(c, ownTitle)).length === 1) {
    return { code: `${own.code}.filter({ hasText: ${q(ownTitle)} })`, description: `“${ownTitle}”`, text, within: ownTitle };
  }
  // Out through a shadow root to its host, as Playwright's filters see.
  const up = (n: Element): Element | null => n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  let node = up(el);
  for (let level = 0; node && node !== document.body && level < SCOPE_LEVELS; level++, node = up(node)) {
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

/**
 * A table cell by its row's own words and its column: `getByRole('row').filter({ hasText: 'Bao Nguyen' })
 * .locator('td').nth(2)`, the “Status” cell for “Bao Nguyen”. Its own words aren't used (they are what a check reads,
 * or what changes); which column it is doesn't change with them.
 */
function cellInRow(el: Element, keep: Keep): LocatorInfo | null {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'td' && tag !== 'th') return null;
  const row = el.parentElement;
  if (!row || row.tagName !== 'TR') return null;
  const title = titleOf(row, el);
  if (!title || !keep(title)) return null;
  const rows = deepAll(document, 'tr').filter((r) => matchesText(r, title));
  if (rows.length !== 1 || rows[0] !== row) return null;
  const cells = Array.from(row.children).filter((c) => c.tagName === el.tagName);
  const i = cells.indexOf(el);
  // The column's heading, as a person names the cell.
  const table = row.closest('table');
  const column = Array.from(row.children).indexOf(el);
  const head = table?.querySelector('thead tr, tr:first-child');
  const heading = head && head !== row ? collapse((head.children[column] as HTMLElement | undefined)?.innerText ?? '', 40) : '';
  const words = heading && !looksVolatile(heading) ? `the “${heading}” cell` : `the ${ordinal(i + 1)} cell`;
  return { code: `page.getByRole('row').filter({ hasText: ${q(title)} }).locator(${q(tag)}).nth(${i})`, description: `${words} for “${title}”`, text: shownText(el), within: title };
}

/**
 * An element told apart by the heading of the part of the page it is in (“Billing”): the part found by that heading,
 * then the element in it, when nothing else in any part so found is found the same way.
 */
function underHeading(el: Element, keep: Keep): LocatorInfo | null {
  const ways = inners(el, keep);
  for (let node = el.parentElement, level = 0; node && node !== document.body && level < SCOPE_LEVELS; node = node.parentElement, level++) {
    const heading = Array.from(node.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).find((h) => !h.contains(el) && !el.contains(h));
    if (!heading) continue;
    const name = accessibleName(heading);
    if (!name || name.length > 60 || looksVolatile(name) || inPrivate(heading) || !keep(name)) continue;
    if (byRole(document, 'heading', name, true, 2).length !== 1) continue;
    const tag = node.tagName.toLowerCase();
    const cls = namingClass(node);
    const css = cls ? `${tag}.${cls}` : tag;
    // Every part this finds (one inside another, too) must hold the element, and it alone found that way.
    const parts = deepAll(document, cls ? `${tag}.${CSS.escape(cls)}` : tag).filter((c) => c.contains(heading));
    if (!parts.every((c) => c.contains(el))) continue;
    const way = ways.find((w) => parts.every((c) => w.count(c) === 1));
    if (!way) continue;
    return { code: `page.locator(${q(css)}).filter({ has: page.getByRole('heading', { name: ${q(name)}, exact: true }) }).${way.code}`, description: `${way.words} under “${name}”`, text: shownText(el), within: name };
  }
  return null;
}

/** Playwright's hasText: the text somewhere inside, ignoring case and spacing. */
function matchesText(el: Element, text: string): boolean {
  return collapse(el.textContent, 100_000).toLowerCase().includes(collapse(text, 200).toLowerCase());
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** The last resort: which of the same it is, counting from the top of the page. */
function nth(el: Element, keep: Keep): LocatorInfo {
  const text = shownText(el);
  const role = roleFor(el);
  const name = named(role) && (!namedByText(el) || keep(accessibleName(el))) ? accessibleName(el) : '';
  const tag = el.tagName.toLowerCase();
  const cls = namingClass(el);
  const pick = (code: string, all: Element[], words: string): LocatorInfo => {
    const i = Math.max(0, all.indexOf(el));
    return all.length > 1 ? { code: `${code}.nth(${i})`, description: `the ${ordinal(i + 1)} ${words}`, text } : { code, description: words, text };
  };
  if (role && name && !looksVolatile(name) && name.length <= 60) return pick(`page.getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, byRole(document, role, name, true), describeRole(role, name).replace(/^the /, ''));
  const css = cls ? `${tag}.${cls}` : tag;
  return pick(`page.locator(${q(css)})`, deepAll(document, cls ? `${tag}.${CSS.escape(cls)}` : tag), cls ? cls.replace(/[-_]/g, ' ') : tag);
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
export function buildLocator(el: Element, opts: { cheap?: boolean; check?: string } = {}): LocatorInfo {
  const text = shownText(el);
  // A check reads what the element shows: it isn't found by words the fix will change.
  const keep = opts.check !== undefined ? keeper(el, opts.check) : always;
  const byName = !namedByText(el) || keep === always;
  // One in a shadow root just made is counted with the rest of the page.
  shadowRoots(el);

  const testId = el.getAttribute('data-testid');
  if (testId && deepAll(document, `[data-testid="${CSS.escape(testId)}"]`).length === 1) {
    // Name it the way a person would: its label, or its text without the values that change.
    const name = collapse((accessibleName(el) || text).replace(/[-−–+]?\s?[$€£¥]?\s?\d[\d.,]*%?/g, ' '), 30);
    return { code: `page.getByTestId(${q(testId)})`, description: name && !looksVolatile(name) ? `“${name}” (${testId})` : testId, text };
  }

  const role = roleFor(el);
  if (named(role)) {
    const name = accessibleName(el);
    if (name && name.length <= 60) {
      // A price or a count in its name is left open: it still finds it once they change.
      const open = openNumbers(name);
      if (open && (byName || keep(open)) && countByRoleAndName(role, open, true) === 1) {
        return { code: `page.getByRole(${q(role)}, { name: ${open.code} })`, description: describeRole(role, name), text };
      }
      if (!looksVolatile(name) && (byName || keep(name))) {
        if (countByRoleAndName(role, name, false) === 1) {
          return { code: `page.getByRole(${q(role)}, { name: ${q(name)} })`, description: describeRole(role, name), text };
        }
        if (countByRoleAndName(role, name, true) === 1) {
          return { code: `page.getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, description: describeRole(role, name), text };
        }
      }
    } else if (name && byName) {
      // A long name (a link that is a whole sentence) by its first words, when they tell it apart.
      const start = name.slice(0, 50).replace(/\s+\S*$/, '');
      if (start.length >= 12 && !looksVolatile(start) && countByRoleAndName(role, start, false) === 1) {
        return { code: `page.getByRole(${q(role)}, { name: ${q(start)} })`, description: describeRole(role, `${start}…`), text };
      }
    }
  }

  const editable = editableOf(el) === el;
  if (isField(el) || editable) {
    // Counted as Playwright finds them: a label or placeholder matches any that contains it (“Password” finds “Show
    // password” too), unless it is exact. A long label is found by its beginning. A rich text editor by its own
    // label (aria-label), which getByLabel finds too.
    const full = isField(el) ? labelText(el) : collapse(el.getAttribute('aria-label'), 60);
    const label = full.replace(/…$/, '');
    if (label) {
      const by = (exact: boolean) => deepAll(document, 'input, textarea, select, [aria-label]').filter((f) => sameWords(labelText(f) || f.getAttribute('aria-label') || '', label, exact)).length;
      if (by(false) === 1) return { code: `page.getByLabel(${q(label)})`, description: `the “${label}” field`, text };
      if (label === full && by(true) === 1) return { code: `page.getByLabel(${q(label)}, { exact: true })`, description: `the “${label}” field`, text };
    }
    const ph = el.getAttribute('placeholder');
    if (ph) {
      const by = (exact: boolean) => deepAll(document, '[placeholder]').filter((f) => sameWords(f.getAttribute('placeholder') ?? '', ph, exact)).length;
      if (by(false) === 1) return { code: `page.getByPlaceholder(${q(ph)})`, description: `the “${ph}” field`, text };
      if (by(true) === 1) return { code: `page.getByPlaceholder(${q(ph)}, { exact: true })`, description: `the “${ph}” field`, text };
    }
  }

  // Counting matches by text walks the whole page: skipped when the caller can't afford it on a large page.
  const affordable = !opts.cheap || document.getElementsByTagName('*').length < 2500;
  if (affordable && !editable) {
    const way = textWays(el, text, keep).find((w) => w.count(document.body) === 1);
    if (way) return { code: `page.${way.code}`, description: `“${text}”`, text };
  }

  // Which of the same it is comes last: before it, the row or the part of the page around it.
  return scoped(el, keep) ?? cellInRow(el, keep) ?? (affordable ? underHeading(el, keep) : null) ?? nth(el, keep);
}
