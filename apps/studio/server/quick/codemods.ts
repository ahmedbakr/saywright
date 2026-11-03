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

function attrString(prop: string, value: string): string {
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

/** Set (or with `value === null`, remove) a string prop on the element at `loc`. */
export function setProp(code: string, loc: Loc, prop: string, value: string | null, ast?: Node): string {
  return setProps(code, loc, [[prop, value]], ast);
}

/** Several props on one element in a single edit: each [prop, value], with null to remove it. */
export function setProps(code: string, loc: Loc, changes: [prop: string, value: string | null][], ast?: Node): string {
  const f = findElement(code, loc, ast);
  if (!f) throw new CodemodError('Element not found at that location');
  const open = f.el.openingElement;
  const s = new MagicString(code);
  const attrs = open.attributes;
  const lastAttr = attrs.length ? attrs[attrs.length - 1] : null;
  const anchorEnd = lastAttr ? lastAttr.end : (open.typeArguments ?? open.typeParameters ?? open.name).end;
  const multiline = lastAttr && lastAttr.loc.start.line > open.loc.start.line;
  let changed = false;

  // Props already there first: a new one goes after the last, which could itself be removed here.
  for (const [prop, value] of changes) {
    const existing = attrs.find((a: Node) => attrName(a) === prop);
    if (!existing) continue;
    if (value === null) {
      let start = existing.start;
      while (start > 0 && /\s/.test(code[start - 1])) start--;
      s.remove(start, existing.end);
    } else if (existing.value == null) {
      s.overwrite(existing.start, existing.end, attrString(prop, value));
    } else if (existing.value.type === 'StringLiteral') {
      s.overwrite(existing.value.start, existing.value.end, /"/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`);
    } else if (existing.value.type === 'JSXExpressionContainer' && ['StringLiteral', 'TemplateLiteral'].includes(existing.value.expression.type)) {
      s.overwrite(existing.value.start, existing.value.end, /"/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`);
    } else {
      throw new CodemodError(`${prop} is computed in code, so it can't be set to a fixed value safely`);
    }
    changed = true;
  }
  for (const [prop, value] of changes) {
    if (value === null || attrs.some((a: Node) => attrName(a) === prop)) continue;
    if (multiline) s.appendLeft(anchorEnd, `\n${indentAt(code, lastAttr.start)}${attrString(prop, value)}`);
    else s.appendLeft(anchorEnd, ` ${attrString(prop, value)}`);
    changed = true;
  }
  if (!changed) return code; // every prop to remove was already absent
  return validate(s, f.el.start, f.el.end);
}

function escapeJsxText(text: string): string {
  return /[{}<>]/.test(text) ? `{${JSON.stringify(text)}}` : text;
}

/** Replace the element's visible text. `textProp` is "children" or a prop name such as "label". */
export function setText(code: string, loc: Loc, text: string, textProp = 'children', ast?: Node): string {
  if (textProp !== 'children') return setProp(code, loc, textProp, text, ast);
  const f = findElement(code, loc, ast);
  if (!f) throw new CodemodError('Element not found at that location');
  const kids = f.el.children.filter((c: Node) => !(c.type === 'JSXText' && !c.value.trim()));
  if (kids.length !== 1 || kids[0].type !== 'JSXText') {
    if (kids.length === 1 && kids[0].type === 'JSXExpressionContainer' && kids[0].expression.type === 'StringLiteral') {
      const s = new MagicString(code);
      s.overwrite(kids[0].start, kids[0].end, `{${JSON.stringify(text)}}`);
      return validate(s, f.el.start, f.el.end);
    }
    throw new ComputedTextError('The text is built from code, not a plain string');
  }
  const node = kids[0];
  const raw = code.slice(node.start, node.end);
  const lead = /^\s*/.exec(raw)![0].length;
  const trail = /\s*$/.exec(raw)![0].length;
  const s = new MagicString(code);
  s.overwrite(node.start + lead, node.end - trail, escapeJsxText(text));
  return validate(s, f.el.start, f.el.end);
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
  const { unit } = childUnit(f, code);
  const r = lineRange(code, unit);
  const s = new MagicString(code);
  s.remove(r.start, r.end);
  return s.toString();
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
  const ra = lineRange(code, a.unit);
  const rb = lineRange(code, b.unit);
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
