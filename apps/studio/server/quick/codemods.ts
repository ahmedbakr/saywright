/**
 * Precise, formatting-preserving JSX edits. Each function takes source code and
 * the location of a JSX element (1-based line and column, exactly as the Vite
 * plugin records them) and returns new source code, or throws CodemodError when
 * the edit cannot be done safely (the caller then hands the request to the AI).
 *
 * A component can be thousands of lines long, so a file is parsed once per request
 * (pass the tree along as `ast`) and the last tree is kept briefly: selecting an
 * element (the Inspector) and then editing it parses the file once. Only the code
 * an edit writes is parsed again to check it.
 */
import { parse, parseExpression } from '@babel/parser';
import MagicString from 'magic-string';

export class CodemodError extends Error {}
/** The text is written as code ({money(total)}), not plain words: no quick edit can change it safely. */
export class ComputedTextError extends CodemodError {}
/** The words are written among other elements (“Hello <b>world</b>”): which part to change can't be told. */
export class MixedTextError extends ComputedTextError {}

// Babel's AST is loosely typed here on purpose: we only touch a handful of fields.
type Node = any;

export interface Loc {
  line: number;
  col: number;
}

const PLUGINS: ('jsx' | 'typescript')[] = ['jsx', 'typescript'];
/** The last file parsed, while it is being worked on. */
let last: { code: string; ast: Node; timer: ReturnType<typeof setTimeout> } | null = null;
const KEEP_MS = 30_000;

/** The file's syntax tree (the same tree again for the same code, for a while). Trees are never changed by the edits. */
export function parseTsx(code: string): Node {
  if (last?.code === code) {
    last.timer.refresh();
    return last.ast;
  }
  const ast = parse(code, { sourceType: 'module', plugins: PLUGINS, attachComment: false });
  if (last) clearTimeout(last.timer);
  const timer = setTimeout(() => (last = null), KEEP_MS);
  timer.unref?.();
  last = { code, ast, timer };
  return ast;
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens']);

/** Where 1-based line `loc.line`, column `loc.col` is in the code. */
function offsetOf(code: string, loc: Loc): number {
  let at = 0;
  for (let line = 1; line < loc.line; line++) {
    const nl = code.indexOf('\n', at);
    if (nl === -1) return -1;
    at = nl + 1;
  }
  return at + loc.col - 1;
}

/** Through the syntax tree, only into nodes that contain `offset`: finding one element in a long file visits a handful of nodes. */
function walkAt(node: Node, parent: Node | null, offset: number, visit: (n: Node, parent: Node | null) => boolean | void): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    for (const child of node) if (child && typeof child === 'object' && (typeof child.start !== 'number' || (child.start <= offset && offset <= child.end)) && walkAt(child, parent, offset, visit)) return true;
    return false;
  }
  if (typeof node.type === 'string') {
    if (typeof node.start === 'number' && (offset < node.start || offset > node.end)) return false;
    if (visit(node, parent)) return true;
  }
  const next = typeof node.type === 'string' ? node : parent;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (v && typeof v === 'object' && walkAt(v, next, offset, visit)) return true;
  }
  return false;
}

export interface Found {
  ast: Node;
  el: Node;
  parent: Node | null;
}

export function findElement(code: string, loc: Loc, parsed?: Node): Found | null {
  const ast = parsed ?? parseTsx(code);
  const offset = offsetOf(code, loc);
  if (offset < 0) return null;
  let found: Found | null = null;
  walkAt(ast, null, offset, (n, parent) => {
    if (n.type === 'JSXElement') {
      const s = n.openingElement.loc.start;
      if (s.line === loc.line && s.column === loc.col - 1) {
        found = { ast, el: n, parent };
        return true;
      }
    }
    return false;
  });
  return found;
}

/** An element's own words as written: its text children, collapsed; empty when they are code (`{t('save')}`) or none. */
export function staticText(el: Node): string {
  let out = '';
  for (const c of el.children ?? []) {
    if (c.type === 'JSXText') out += ` ${c.value}`;
    else if (c.type === 'JSXExpressionContainer' && c.expression?.type === 'StringLiteral') out += ` ${c.expression.value}`;
    else if (c.type === 'JSXExpressionContainer' && c.expression?.type !== 'JSXEmptyExpression') return '';
  }
  return plain(out);
}

/** JSX text as it reads: entities decoded, spaces collapsed. */
function plain(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether the code's element can be the one that showed `text` (its own words are in it); true when it can't be told. */
export function showsText(el: Node, text: string): boolean {
  const own = staticText(el).toLowerCase();
  const shown = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return !own || !shown || shown.includes(own);
}

/**
 * The element named `name` that shows `text`, near where one was (the code moved: lines added above it, or another
 * element now at its place), by its own words. `many` when several fit: never a guess between look-alikes.
 */
export function findByWords(code: string, near: Loc, name: string, text: string, ast?: Node): { loc: Loc; found: Found } | 'many' | null {
  const tree = ast ?? parseTsx(code);
  if (!text.trim()) return null;
  const fits: Node[] = [];
  const stack: Node[] = [tree.program];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) {
      for (const c of n) stack.push(c);
      continue;
    }
    if (n.type === 'JSXElement' && Math.abs(n.loc.start.line - near.line) <= 60 && elementName(n) === name && staticText(n) && showsText(n, text)) fits.push(n);
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = n[key];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  if (fits.length > 1) return 'many';
  if (!fits.length) return null;
  const at = fits[0].openingElement.loc.start;
  const loc = { line: at.line, col: at.column + 1 };
  const found = findElement(code, loc, tree);
  return found ? { loc, found } : null;
}

export function elementName(el: Node): string {
  const name = (n: Node): string =>
    n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${name(n.object)}.${name(n.property)}` : '';
  return name(el.openingElement.name);
}

function attrName(a: Node): string | null {
  return a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' ? a.name.name : null;
}

type PropValue = { kind: 'literal'; value: string } | { kind: 'dynamic' } | { kind: 'boolean' };

/** Literal props written at this JSX site. */
export function readProps(el: Node): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const a of el.openingElement.attributes) {
    const n = attrName(a);
    if (!n) continue;
    if (a.value == null) out[n] = { kind: 'boolean' };
    else if (a.value.type === 'StringLiteral') out[n] = { kind: 'literal', value: a.value.value };
    else if (a.value.type === 'JSXExpressionContainer' && a.value.expression.type === 'StringLiteral') out[n] = { kind: 'literal', value: a.value.expression.value };
    else if (a.value.type === 'JSXExpressionContainer' && ['BooleanLiteral', 'NumericLiteral'].includes(a.value.expression.type)) out[n] = { kind: 'literal', value: String(a.value.expression.value) };
    else if (a.value.type === 'JSXExpressionContainer' && a.value.expression.type === 'TemplateLiteral' && a.value.expression.expressions.length === 0) {
      out[n] = { kind: 'literal', value: a.value.expression.quasis[0].value.cooked };
    } else out[n] = { kind: 'dynamic' };
  }
  return out;
}

function lineStart(code: string, i: number): number {
  return code.lastIndexOf('\n', i - 1) + 1;
}
function lineEnd(code: string, i: number): number {
  const e = code.indexOf('\n', i);
  return e === -1 ? code.length : e;
}
function indentAt(code: string, i: number): string {
  const s = lineStart(code, i);
  return /^[ \t]*/.exec(code.slice(s))![0];
}

/** A prop's value: a string, or code (`{ code: '3' }`, `{ code: 'true' }`, written `prop={3}`, `prop`); null removes it. */
export type PropWrite = string | null | { code: string };

function attrString(prop: string, value: string | { code: string }): string {
  if (typeof value !== 'string') return value.code === 'true' ? prop : `${prop}={${value.code}}`;
  return /["\n]/.test(value) ? `${prop}={${JSON.stringify(value)}}` : `${prop}="${value}"`;
}

/**
 * Check the element an edit rewrote (`start`…`end` in the old code), which is all that changed: the rest of the
 * file parsed before and is untouched, and an element's markup stands on its own.
 */
function validate(s: MagicString, start: number, end: number): string {
  const after = s.toString();
  const grown = after.length - s.original.length;
  try {
    parseExpression(after.slice(start, end + grown), { plugins: PLUGINS });
  } catch (err) {
    throw new CodemodError(`Edit produced invalid code: ${(err as Error).message}`);
  }
  return after;
}

/**
 * Set (or with `value === null`, remove) a string prop on the element at `loc`. With `into`, the edit is written into
 * that MagicString of the same code (several elements changed in one pass); the caller then checks the whole result.
 */
export function setProp(code: string, loc: Loc, prop: string, value: PropWrite, ast?: Node, into?: MagicString): string {
  return setProps(code, loc, [[prop, value]], ast, into);
}

/** Several props on one element in a single edit: each [prop, value], with null to remove it. */
export function setProps(code: string, loc: Loc, changes: [prop: string, value: PropWrite][], ast?: Node, into?: MagicString): string {
  const f = findElement(code, loc, ast);
  if (!f) throw new CodemodError('Element not found at that location');
  const open = f.el.openingElement;
  const s = into ?? new MagicString(code);
  const attrs = open.attributes;
  const lastAttr = attrs.length ? attrs[attrs.length - 1] : null;
  const anchorEnd = lastAttr ? lastAttr.end : (open.typeArguments ?? open.typeParameters ?? open.name).end;
  const multiline = lastAttr && lastAttr.loc.start.line > open.loc.start.line;
  // A new prop goes before the props spread last (`<Button {...props}>`): after them it would always win over what
  // the caller passes.
  let spread = attrs.length;
  while (spread > 0 && attrs[spread - 1].type === 'JSXSpreadAttribute') spread--;
  const firstSpread = spread < attrs.length ? attrs[spread] : null;
  // A line of its own ends as the file's lines do (CRLF in a CRLF file).
  const eol = lastAttr && code[lineEnd(code, lastAttr.end) - 1] === '\r' ? '\r\n' : '\n';
  let changed = false;

  // Props already there first: a new one goes after the last, which could itself be removed here.
  for (const [prop, value] of changes) {
    const existing = attrs.find((a: Node) => attrName(a) === prop);
    if (!existing) continue;
    if (value === null) {
      let start = existing.start;
      while (start > 0 && /\s/.test(code[start - 1])) start--;
      s.remove(start, existing.end);
    } else if (existing.value == null || typeof value !== 'string') {
      if (existing.value?.type === 'JSXExpressionContainer' && !['StringLiteral', 'TemplateLiteral', 'BooleanLiteral', 'NumericLiteral'].includes(existing.value.expression.type)) {
        throw new CodemodError(`${prop} is computed in code, so it can't be set to a fixed value safely`);
      }
      s.overwrite(existing.start, existing.end, attrString(prop, value));
    } else if (existing.value.type === 'StringLiteral') {
      s.overwrite(existing.value.start, existing.value.end, /"/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`);
    } else if (existing.value.type === 'JSXExpressionContainer' && ['StringLiteral', 'TemplateLiteral', 'BooleanLiteral', 'NumericLiteral'].includes(existing.value.expression.type)) {
      s.overwrite(existing.value.start, existing.value.end, /"/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`);
    } else {
      throw new CodemodError(`${prop} is computed in code, so it can't be set to a fixed value safely`);
    }
    changed = true;
  }
  for (const [prop, value] of changes) {
    if (value === null || attrs.some((a: Node) => attrName(a) === prop)) continue;
    if (firstSpread && firstSpread.loc.start.line > open.loc.start.line && /^\s*$/.test(code.slice(lineStart(code, firstSpread.start), firstSpread.start))) {
      s.prependLeft(lineStart(code, firstSpread.start), `${indentAt(code, firstSpread.start)}${attrString(prop, value)}${eol}`);
    } else if (firstSpread) s.prependLeft(firstSpread.start, `${attrString(prop, value)} `);
    else if (multiline) s.appendLeft(anchorEnd, `${eol}${indentAt(code, lastAttr.start)}${attrString(prop, value)}`);
    else s.appendLeft(anchorEnd, ` ${attrString(prop, value)}`);
    changed = true;
  }
  if (!changed) return code; // every prop to remove was already absent
  return into ? into.toString() : validate(s, f.el.start, f.el.end);
}

function escapeJsxText(text: string): string {
  return /[{}<>]/.test(text) ? `{${JSON.stringify(text)}}` : text;
}

/** Writes no words of its own: an input, an icon, a picture (or an element holding only such). */
function wordless(n: Node): boolean {
  if (n.type === 'JSXText') return !n.value.trim();
  if (n.type === 'JSXExpressionContainer') return n.expression?.type === 'JSXEmptyExpression';
  return n.type === 'JSXElement' && n.children.every(wordless);
}

/**
 * Replace the element's visible text. `textProp` is "children" or a prop name such as "label". `shown`, the words the
 * page showed for it, when known: words written beside an input or an icon are changed only when they are all it shows.
 */
export function setText(code: string, loc: Loc, text: string, textProp = 'children', ast?: Node, shown?: string, into?: MagicString): string {
  if (textProp !== 'children') return setProp(code, loc, textProp, text, ast, into);
  const f = findElement(code, loc, ast);
  if (!f) throw new CodemodError('Element not found at that location');
  const kids = f.el.children.filter((c: Node) => !(c.type === 'JSXText' && !c.value.trim()));
  let node: Node = kids[0];
  if (kids.length !== 1 || kids[0].type !== 'JSXText') {
    if (kids.length === 1 && kids[0].type === 'JSXExpressionContainer' && kids[0].expression.type === 'StringLiteral') {
      const s = into ?? new MagicString(code);
      s.overwrite(kids[0].start, kids[0].end, `{${JSON.stringify(text)}}`);
      return into ? into.toString() : validate(s, f.el.start, f.el.end);
    }
    // Words beside an input, an icon or a picture (“<label>Email <input /></label>”): the words are what changes.
    const own = kids.filter((c: Node) => c.type === 'JSXText');
    const beside = own.length === 1 && kids.every((c: Node) => c === own[0] || (c.type === 'JSXElement' && wordless(c)));
    if (!beside || (shown?.trim() && plain(shown).toLowerCase() !== plain(own[0].value).toLowerCase())) {
      if (kids.every((c: Node) => c.type === 'JSXText' || c.type === 'JSXElement')) throw new MixedTextError('The words are written among other elements');
      throw new ComputedTextError('The text is built from code, not a plain string');
    }
    node = own[0];
  }
  const raw = code.slice(node.start, node.end);
  const lead = /^\s*/.exec(raw)![0].length;
  const trail = /\s*$/.exec(raw)![0].length;
  const s = into ?? new MagicString(code);
  s.overwrite(node.start + lead, node.end - trail, escapeJsxText(text));
  return into ? into.toString() : validate(s, f.el.start, f.el.end);
}

/** The child unit that represents the element inside its parent's children (the element, or `{cond && <El/>}`). */
function childUnit(f: Found, code: string): { unit: Node; container: Node } {
  const { el } = f;
  const ast = f.ast;
  let result: { unit: Node; container: Node } | null = null;
  walkAt(ast, null, el.start, (n) => {
    if ((n.type === 'JSXElement' || n.type === 'JSXFragment') && Array.isArray(n.children)) {
      for (const c of n.children) {
        if (c === el) {
          result = { unit: c, container: n };
          return true;
        }
        if (c.type === 'JSXExpressionContainer') {
          const e = c.expression;
          if (e?.type === 'LogicalExpression' && e.right === el) {
            result = { unit: c, container: n };
            return true;
          }
        }
      }
    }
    return false;
  });
  if (!result) throw new CodemodError(`This element is not a direct child of other markup (${code.slice(el.start, el.start + 20)}…)`);
  return result;
}

/** Range covering whole lines when the node sits alone on its lines; otherwise the node itself. */
function lineRange(code: string, node: Node): { start: number; end: number; whole: boolean } {
  const ls = lineStart(code, node.start);
  const le = lineEnd(code, node.end);
  const before = code.slice(ls, node.start);
  const after = code.slice(node.end, le);
  if (!before.trim() && !after.trim()) return { start: ls, end: Math.min(code.length, le + 1), whole: true };
  return { start: node.start, end: node.end, whole: false };
}

/**
 * Removing (or moving) a whole child of other markup, with only the blank space of its own lines, leaves valid
 * markup around it: these two need no parse to check.
 */
export function removeElement(code: string, loc: Loc, ast?: Node): string {
  const f = findElement(code, loc, ast);
  if (!f) throw new CodemodError('Element not found at that location');
  const r = removalRange(f, code);
  const s = new MagicString(code);
  s.overwrite(r.start, r.end, r.text);
  return s.toString();
}

/**
 * What taking the element out replaces, and with what. A child of markup goes with its own lines, and with its
 * `{cond && …}` (nothing is left to show). The fallback of `a || <El/>` or `a ?? <El/>` leaves `a`, which is what
 * shows the rest of the time; one branch of `cond ? <A/> : <B/>` leaves `null`, so the other still shows.
 */
function removalRange(f: Found, code: string): { start: number; end: number; text: string } {
  const p = f.parent;
  if (p?.type === 'LogicalExpression' && p.right === f.el && p.operator !== '&&') {
    let start = code.indexOf(p.operator, p.left.end);
    while (start > 0 && /\s/.test(code[start - 1])) start--;
    return { start, end: p.end, text: '' };
  }
  if (p?.type === 'ConditionalExpression' && (p.consequent === f.el || p.alternate === f.el)) {
    const paren = f.el.extra?.parenthesized ? f.el.extra.parenStart : null;
    if (typeof paren === 'number') return { start: paren, end: code.indexOf(')', f.el.end) + 1, text: 'null' };
    return { start: f.el.start, end: f.el.end, text: 'null' };
  }
  const { unit } = childUnit(f, code);
  const r = lineRange(code, unit);
  return { start: r.start, end: r.end, text: '' };
}

/** Names never taken out with what used them: the JSX of the classic runtime needs them in scope unwritten. */
const KEEP_IMPORTS = new Set(['React', 'h']);

/** Removing one element: see removeElementsTidy. */
export function removeElementTidy(code: string, loc: Loc, ast?: Node): { code: string; took: string[]; unused: string[] } {
  return removeElementsTidy(code, [loc], ast);
}

/**
 * Remove the elements at `locs` (all found in this code, as it is, before any is taken out), and what only they used,
 * so the app still builds (an unused import or prop fails a build that checks for them): the imports, and the props
 * their components read for them (unless the props are spread on, where leaving one out would change what is passed).
 * Anything else only they used (a variable, a helper, a hook's value) may do something besides, so it stays and is
 * named in `unused`. Every edit is made on the code as it was, in one pass: no removal moves the place of another.
 */
export function removeElementsTidy(code: string, locs: Loc[], ast?: Node): { code: string; took: string[]; unused: string[] } {
  const tree = ast ?? parseTsx(code);
  const found = locs.map((loc) => {
    const f = findElement(code, loc, tree);
    if (!f) throw new CodemodError('Element not found at that location');
    return f;
  });
  const parts = found.map((f) => ({ f, r: removalRange(f, code) }));
  // One inside another picked one goes with it; two that only partly overlap can't both be taken out cleanly.
  const outer = parts.filter((p, i) => !parts.some((o, j) => j !== i && o.r.start <= p.r.start && p.r.end <= o.r.end && (o.r.end - o.r.start > p.r.end - p.r.start || j < i)));
  for (const p of outer) for (const o of outer) if (p !== o && p.r.start < o.r.end && o.r.start < p.r.end) throw new CodemodError('Two of the elements overlap in the code');
  const s = new MagicString(code);
  for (const { r } of outer) {
    if (r.end > r.start) s.overwrite(r.start, r.end, r.text);
    else if (r.text) s.appendLeft(r.start, r.text);
  }
  const removed = outer.map((p) => p.r);
  const inside = (n: Node) => removed.some((r) => n.start < r.end && r.start < n.end);
  const before = nameCounts(tree.program);
  const took: string[] = [];
  /** Written somewhere besides its own declaration before the removal, and nowhere after it. */
  const gone = (now: Map<string, number>) => (name: string, own: number) => (before.get(name) ?? 0) > own && (now.get(name) ?? 0) <= own;
  let currentTree: Node;
  try {
    currentTree = parseTsx(s.toString());
  } catch {
    return { code: s.toString(), took: [], unused: [] };
  }
  let done = s;

  // First the props the components around them read only for them; a default value of one may be the last use of
  // an import.
  const fns = [...new Set(outer.flatMap((p) => functionsAround(tree, p.f.el.start)))];
  {
    const lastUseGone = gone(nameCounts(currentTree.program));
    const next = done.clone();
    let changed = false;
    for (const fn of fns) {
      const pattern = fn.params?.[0];
      if (pattern?.type !== 'ObjectPattern' || inside(pattern) || pattern.properties.some((p: Node) => p.type === 'RestElement')) continue;
      const drop = new Set<Node>();
      for (const prop of pattern.properties) {
        const name = boundName(prop);
        if (name && lastUseGone(name, occurrences(prop, name))) drop.add(prop);
      }
      if (!drop.size) continue;
      for (const prop of drop) took.push(`the ${boundName(prop)} prop`);
      if (drop.size === pattern.properties.length) {
        // None left: the component takes its props without reading them (`_props`, which no build calls unused).
        const close = code.indexOf('}', pattern.properties[pattern.properties.length - 1].end);
        next.overwrite(pattern.start, close + 1, '_props');
      } else dropFromList(next, pattern.properties, drop);
      changed = true;
    }
    if (changed) {
      try {
        currentTree = parseTsx(next.toString());
        done = next;
      } catch {
        took.length = 0;
      }
    }
  }

  // Then the imports only they used (or a default value they took with them).
  {
    const lastUseGone = gone(nameCounts(currentTree.program));
    const next = done.clone();
    const named: string[] = [];
    for (const decl of tree.program.body) {
      if (decl.type !== 'ImportDeclaration' || !decl.specifiers.length) continue;
      const specs: Node[] = decl.specifiers;
      const drop = specs.filter((sp) => !KEEP_IMPORTS.has(sp.local.name) && lastUseGone(sp.local.name, 0));
      if (!drop.length) continue;
      for (const sp of drop) named.push(`the ${sp.local.name} import`);
      if (drop.length === specs.length) {
        const r = lineRange(code, decl);
        next.remove(r.start, r.end);
        continue;
      }
      const def = specs.find((sp) => sp.type === 'ImportDefaultSpecifier');
      const ns = specs.find((sp) => sp.type === 'ImportNamespaceSpecifier');
      const list = specs.filter((sp) => sp.type === 'ImportSpecifier');
      const out = new Set(drop);
      // `X, { A }` → `{ A }`; `X, * as NS` → `* as NS`.
      if (def && out.has(def)) next.remove(def.start, ns ? ns.start : code.indexOf('{', def.end));
      if (ns && out.has(ns)) next.remove(def ? def.end : ns.start, ns.end);
      // `X, { A }` → `X`.
      if (list.length && list.every((sp) => out.has(sp))) {
        if (def) next.remove(def.end, code.indexOf('}', list[list.length - 1].end) + 1);
      } else dropFromList(next, list, out);
    }
    if (named.length) {
      try {
        currentTree = parseTsx(next.toString());
        done = next;
        took.unshift(...named);
      } catch {
        // Left as they were.
      }
    }
  }

  // What else only they used, which may do more than they needed (a value worked out, a hook): named, left as it is.
  const lastUseGone = gone(nameCounts(currentTree.program));
  const unused: string[] = [];
  for (const fn of fns) for (const [name, own] of declaredIn(fn.body)) if (lastUseGone(name, own) && !unused.includes(name)) unused.push(name);
  for (const [name, own] of declaredIn(tree.program)) if (lastUseGone(name, own) && !unused.includes(name)) unused.push(name);
  return { code: done.toString(), took, unused };
}

/** Nodes whose `key` is a name written in place, not a use of one (`{ title: … }`, `title: string` in a type). */
const NAMED_KEYS = new Set(['ObjectProperty', 'ObjectMethod', 'ClassProperty', 'ClassMethod', 'ClassAccessorProperty', 'TSPropertySignature', 'TSMethodSignature']);

/**
 * How often each name is written outside imports, as a use or a binding: not where it only names a property
 * (`row.title`, `{ title: … }`, `<Field title=…>`, a type's `title: string`), which uses nothing by that name.
 */
function nameCounts(root: Node, skip?: Node): Map<string, number> {
  const counts = new Map<string, number>();
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || n === skip) continue;
    if (Array.isArray(n)) {
      for (const c of n) stack.push(c);
      continue;
    }
    if (n.type === 'ImportDeclaration') continue;
    if ((n.type === 'Identifier' || n.type === 'JSXIdentifier') && typeof n.name === 'string') counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      if (key === 'key' && NAMED_KEYS.has(n.type) && !n.computed) continue;
      if (key === 'property' && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression' || n.type === 'JSXMemberExpression') && !n.computed) continue;
      if (key === 'name' && n.type === 'JSXAttribute') continue;
      if (key === 'right' && n.type === 'TSQualifiedName') continue;
      const v = n[key];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return counts;
}

/** How often `name` is written in a binding, its default value left out (that is a use of other names). */
function occurrences(binding: Node, name: string): number {
  const defaults = binding.value?.type === 'AssignmentPattern' ? binding.value.right : binding.type === 'AssignmentPattern' ? binding.right : undefined;
  return nameCounts(binding, defaults).get(name) ?? 0;
}

/** The name a property of a destructuring binds (`{ onDelete }`, `{ onDelete: del }`, `{ size = 'md' }`). */
function boundName(prop: Node): string | null {
  if (prop.type !== 'ObjectProperty' || prop.computed) return null;
  const v = prop.value;
  if (v?.type === 'Identifier') return v.name;
  if (v?.type === 'AssignmentPattern' && v.left.type === 'Identifier') return v.left.name;
  return null;
}

/**
 * The component the element at `loc` is part of: the nearest function around it named like one (`function Card`,
 * `const Card = () => …`). Null outside one.
 */
export function componentAt(code: string, loc: Loc, ast?: Node): string | null {
  const tree = ast ?? parseTsx(code);
  const offset = offsetOf(code, loc);
  if (offset < 0) return null;
  // The nodes around it, outermost first.
  const chain: Node[] = [];
  walkAt(tree, null, offset, (n) => {
    chain.push(n);
    return false;
  });
  let name: string | null = null;
  chain.forEach((n, i) => {
    if (n.type !== 'FunctionDeclaration' && n.type !== 'FunctionExpression' && n.type !== 'ArrowFunctionExpression') return;
    // Kept in a variable, maybe wrapped (`const Card = memo(function Inner…)`, `forwardRef((…) => …)`): used by that name.
    let j = i - 1;
    while (j >= 0 && chain[j].type === 'CallExpression') j--;
    const holder = chain[j]?.type === 'VariableDeclarator' && chain[j].id.type === 'Identifier' ? chain[j].id.name : null;
    const own = holder ?? n.id?.name ?? null;
    if (own && /^[A-Z]/.test(own)) name = own;
  });
  return name;
}

/** The functions around a place in the code, innermost first. */
function functionsAround(ast: Node, offset: number): Node[] {
  const out: Node[] = [];
  walkAt(ast, null, offset, (n) => {
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') out.unshift(n);
    return false;
  });
  return out;
}

/** Names a block declares directly (not exported), with how often each is written in its declaration. */
function declaredIn(block: Node): [string, number][] {
  const out: [string, number][] = [];
  const statements: Node[] = block?.type === 'BlockStatement' || block?.type === 'Program' ? block.body : [];
  for (const st of statements) {
    if (st.type === 'FunctionDeclaration' && st.id) out.push([st.id.name, 1]);
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      const names: string[] = [];
      const collect = (p: Node) => {
        if (!p) return;
        if (p.type === 'Identifier') names.push(p.name);
        else if (p.type === 'ObjectPattern') for (const prop of p.properties) collect(prop.type === 'RestElement' ? prop.argument : prop.value);
        else if (p.type === 'ArrayPattern') for (const e of p.elements) collect(e);
        else if (p.type === 'AssignmentPattern') collect(p.left);
      };
      collect(d.id);
      for (const name of names) out.push([name, nameCounts(d.id, undefined).get(name) ?? 1]);
    }
  }
  return out;
}

/** Take `drop` out of a comma-separated list, each run of them with the comma joining it to what stays. */
function dropFromList(s: MagicString, items: Node[], drop: Set<Node>): void {
  let i = 0;
  while (i < items.length) {
    if (!drop.has(items[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < items.length && drop.has(items[j + 1])) j++;
    if (j + 1 < items.length) s.remove(items[i].start, items[j + 1].start);
    else if (i > 0) s.remove(items[i - 1].end, items[j].end);
    else s.remove(items[i].start, items[j].end);
    i = j + 1;
  }
}

/**
 * The whole lines of an element with the comment written on the lines right above it (`{/* the total *\/}`), which
 * describes it: moved, the element takes it along rather than leave it describing its neighbour.
 */
function withComment(code: string, r: { start: number; end: number; whole: boolean }): { start: number; end: number; whole: boolean } {
  if (!r.whole) return r;
  let start = r.start;
  for (;;) {
    if (start === 0) break;
    const prevStart = lineStart(code, start - 1);
    const line = code.slice(prevStart, start).trim();
    if (/^\{\s*\/\*[\s\S]*\*\/\s*\}$/.test(line) || /^\/\//.test(line)) {
      start = prevStart;
      continue;
    }
    // A comment over several lines: from its last line back to its first.
    if (/\*\/\s*\}$/.test(line)) {
      const open = code.lastIndexOf('{/*', start);
      if (open < 0 || code.slice(lineStart(code, open), open).trim()) break;
      start = lineStart(code, open);
      continue;
    }
    break;
  }
  return { ...r, start };
}

export function moveElement(code: string, from: Loc, to: Loc, where: 'above' | 'below', parsed?: Node): string {
  const ast = parsed ?? parseTsx(code); // one parse, so parent nodes can be compared by identity
  const fa = findElement(code, from, ast);
  const fb = findElement(code, to, ast);
  if (!fa || !fb) throw new CodemodError('Element not found at that location');
  const a = childUnit(fa, code);
  const b = childUnit(fb, code);
  if (a.container !== b.container) throw new CodemodError('They are in different parents, so a simple move would change the layout structure');
  if (a.unit === b.unit) throw new CodemodError('That is the same element');
  const ra = withComment(code, lineRange(code, a.unit));
  const rb = withComment(code, lineRange(code, b.unit));
  if (!ra.whole || !rb.whole) throw new CodemodError('Elements share a line with other markup');
  const piece = code.slice(ra.start, ra.end);
  const s = new MagicString(code);
  const at = where === 'above' ? rb.start : rb.end;
  if ((where === 'above' && ra.end === rb.start) || (where === 'below' && ra.start === rb.end)) return code; // already there
  s.remove(ra.start, ra.end);
  if (where === 'above') s.prependLeft(at, piece);
  else s.appendRight(at, piece);
  return s.toString();
}
