/**
 * Moving a selection around the page: out to what contains it, inside it, to
 * the next or previous one, or to the nearest element a word names ("the
 * card", "the button inside"). Steps skip wrappers that are exactly the same
 * size as where they start, so every step visibly moves.
 */
import { NAME_ATTR, SRC_ATTR } from '../protocol';
import { annotatedAncestor, isVisible, rectOf, roleOf } from './dom';

export type Step = 'parent' | 'child' | 'next' | 'prev';

const isAnnotated = (el: Element) => annotatedAncestor(el) === el;
const isPage = (el: Element | null) => !el || el === document.body || el === document.documentElement;

function sameBox(a: Element, b: Element): boolean {
  const ra = rectOf(a);
  const rb = rectOf(b);
  return Math.abs(ra.x - rb.x) <= 1 && Math.abs(ra.y - rb.y) <= 1 && Math.abs(ra.w - rb.w) <= 1 && Math.abs(ra.h - rb.h) <= 1;
}

/** The visible elements one level down: annotated, with no annotated element between them and `root`, in page order. */
function childrenOf(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (node: Element, depth: number) => {
    if (depth > 60) return;
    for (const c of Array.from(node.children)) {
      if (c instanceof HTMLScriptElement || c instanceof HTMLStyleElement || c.tagName === 'TEMPLATE') continue;
      if (isAnnotated(c) && isVisible(c)) out.push(c);
      else walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function parentOf(el: Element): Element | null {
  let cur = annotatedAncestor(el.parentElement);
  while (cur && !isPage(cur) && (!isVisible(cur) || sameBox(cur, el))) cur = annotatedAncestor(cur.parentElement);
  return isPage(cur) ? null : cur;
}

function childOf(el: Element): Element | null {
  let kids = childrenOf(el);
  // A wrapper exactly as big as its parent: look inside it instead.
  for (let i = 0; i < 8 && kids.length === 1 && sameBox(kids[0], el); i++) kids = childrenOf(kids[0]);
  return kids[0] ?? null;
}

/** The next or previous one: of the same kind (rendered by the same line, like items in a list) when there are others, else at the same level. */
function siblingOf(el: Element, dir: 1 | -1): Element | null {
  const src = el.getAttribute(SRC_ATTR);
  if (src) {
    const same = Array.from(document.querySelectorAll(`[${SRC_ATTR}="${CSS.escape(src)}"]`)).filter(isVisible);
    const i = same.indexOf(el);
    if (same.length > 1 && i >= 0) return same[i + dir] ?? null;
  }
  const level = childrenOf(annotatedAncestor(el.parentElement) ?? document.body);
  const i = level.indexOf(el);
  return i >= 0 ? (level[i + dir] ?? null) : null;
}

export function step(el: Element, to: Step): Element | null {
  switch (to) {
    case 'parent':
      return parentOf(el);
    case 'child':
      return childOf(el);
    case 'next':
      return siblingOf(el, 1);
    case 'prev':
      return siblingOf(el, -1);
  }
}

/** What people call things, to what pages are made of. */
const KINDS: Record<string, string[]> = {
  button: ['button'],
  link: ['a', 'link'],
  image: ['img', 'image', 'picture', 'photo', 'svg', 'icon', 'avatar', 'thumbnail', 'logo'],
  heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'heading', 'title', 'headline'],
  field: ['input', 'textarea', 'select', 'textbox', 'searchbox', 'combobox', 'listbox', 'field'],
  list: ['ul', 'ol', 'list'],
  item: ['li', 'listitem', 'item', 'row', 'tr'],
  text: ['p', 'span', 'paragraph', 'text', 'label'],
  section: ['section', 'region'],
  menu: ['nav', 'navigation', 'menu', 'menubar'],
  dialog: ['dialog', 'modal', 'popup', 'drawer'],
  table: ['table', 'grid'],
};
const ALIASES: Record<string, string> = {
  img: 'image', picture: 'image', photo: 'image', icon: 'image', logo: 'image', pic: 'image',
  title: 'heading', headline: 'heading',
  input: 'field', textbox: 'field', box: 'field', 'text box': 'field', 'text field': 'field', dropdown: 'field',
  row: 'item', entry: 'item',
  paragraph: 'text', label: 'text', caption: 'text',
  nav: 'menu', navigation: 'menu', navbar: 'menu',
  modal: 'dialog', popup: 'dialog', drawer: 'dialog',
};

/** "ProductCard" → product, card; "add-to-cart" → add, to, cart. */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a person would call this element `what` ("card", "button", "price"). */
export function called(el: Element, what: string): boolean {
  const said = what.toLowerCase().trim().replace(/\s+/g, ' ');
  if (!said) return false;
  // "buttons" names buttons too; "glass" isn't "glas".
  const forms = said.length > 3 && said.endsWith('s') && !said.endsWith('ss') ? [said, said.slice(0, -1)] : [said];
  const tag = el.tagName.toLowerCase();
  const role = roleOf(el) ?? '';
  const name = words(el.getAttribute(NAME_ATTR) ?? '');
  // A compound name is a kind of its last word: a ProductCard is a card, a CardHeader is a header.
  const heads = (s: string | null) => (s ?? '').split(/\s+/).flatMap((part) => words(part).slice(-1));
  const own = [tag, role, ...name.slice(-1), ...heads(typeof el.className === 'string' ? el.className : ''), ...heads(el.getAttribute('data-slot')), ...heads(el.getAttribute('data-testid')), ...heads(el.id)];
  return forms.some((w) => (KINDS[ALIASES[w] ?? w] ?? [w]).some((k) => own.includes(k)) || name.join('') === w.replace(/ /g, ''));
}

/**
 * The nearest element called `what`, from `from`: what contains it first
 * (closest first), then what is inside it (nearest first), unless `where`
 * says which. With nothing to start from, the first one on screen.
 */
export function find(from: Element | null, what: string, where: 'any' | 'out' | 'in' = 'any'): Element | null {
  if (!from) {
    const all = Array.from(document.body.querySelectorAll('*')).filter((el) => called(el, what) && isAnnotated(el) && isVisible(el));
    const onScreen = all.find((el) => {
      const r = rectOf(el);
      return r.y + r.h > 0 && r.y < window.innerHeight && r.x + r.w > 0 && r.x < window.innerWidth;
    });
    return onScreen ?? all[0] ?? null;
  }
  if (where !== 'in') {
    for (let cur = parentOf(from); cur; cur = parentOf(cur)) if (called(cur, what)) return cur;
  }
  if (where !== 'out') {
    // Breadth first, so the nearest one inside wins.
    let level = [from];
    for (let depth = 0; depth < 30 && level.length; depth++) {
      const next: Element[] = [];
      for (const el of level) {
        for (const c of childrenOf(el)) {
          if (called(c, what)) return c;
          next.push(c);
        }
      }
      level = next;
    }
  }
  return null;
}
