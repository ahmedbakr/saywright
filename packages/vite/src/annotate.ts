/**
 * Compile-time JSX annotation. Every JSX element gets
 *   data-ds-src="relative/file.tsx:line:col" data-ds-name="Component"
 * inserted right after its tag name, before any other attribute. Because the
 * attributes come first, a component that spreads its props onto its root DOM
 * node (`<button {...rest}>`) ends up showing the *instance* site, which is
 * where a prop change belongs.
 */
import { parse } from '@babel/parser';
import MagicString from 'magic-string';
import { NAME_ATTR, SRC_ATTR } from './protocol';

const SKIP_COMPONENTS = new Set([
  'Fragment',
  'React.Fragment',
  'StrictMode',
  'React.StrictMode',
  'Suspense',
  'React.Suspense',
  'Profiler',
  'React.Profiler',
  'Activity',
  'React.Activity',
]);

/** SVG primitives are noise for pointing; the <svg> root is still annotated. */
const SVG_INNER = new Set(
  [
    'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'defs', 'use',
    'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'symbol', 'text',
    'tspan', 'filter', 'title', 'desc', 'marker', 'foreignobject',
  ],
);

type AnyNode = { type: string; start?: number | null; end?: number | null; [k: string]: unknown };

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens']);

function walk(node: unknown, visit: (n: AnyNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as AnyNode;
  if (typeof n.type === 'string') visit(n);
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = n[key];
    if (value && typeof value === 'object') walk(value, visit);
  }
}

export function jsxName(name: AnyNode | undefined | null): string | null {
  if (!name) return null;
  if (name.type === 'JSXIdentifier') return String(name.name);
  if (name.type === 'JSXMemberExpression') {
    const object = jsxName(name.object as AnyNode);
    const property = jsxName(name.property as AnyNode);
    return object && property ? `${object}.${property}` : null;
  }
  return null; // namespaced names like svg:foo are skipped
}

function shouldAnnotate(name: string): boolean {
  if (SKIP_COMPONENTS.has(name)) return false;
  if (name.endsWith('.Provider') || name.endsWith('.Consumer')) return false;
  if (SVG_INNER.has(name.toLowerCase()) && name === name.toLowerCase()) return false;
  return true;
}

interface AnnotateResult {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  count: number;
}

export function annotate(code: string, file: string, relPath: string): AnnotateResult | null {
  if (!code.includes('<')) return null;
  let ast: unknown;
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    });
  } catch {
    return null; // let the normal pipeline report syntax errors
  }

  const s = new MagicString(code);
  let count = 0;
  const safePath = relPath.replace(/"/g, '');

  walk(ast, (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    const nameNode = node.name as AnyNode;
    const name = jsxName(nameNode);
    if (!name || !shouldAnnotate(name)) return;
    const attrs = (node.attributes as AnyNode[]) ?? [];
    const already = attrs.some(
      (a) => a.type === 'JSXAttribute' && (a.name as AnyNode)?.type === 'JSXIdentifier' && (a.name as AnyNode).name === SRC_ATTR,
    );
    if (already) return;
    const loc = node.loc as { start: { line: number; column: number } } | undefined;
    if (!loc) return;
    const typeArgs = (node.typeArguments ?? node.typeParameters) as AnyNode | undefined;
    const insertAt = (typeArgs?.end ?? nameNode.end) as number | undefined;
    if (typeof insertAt !== 'number') return;
    s.appendLeft(insertAt, ` ${SRC_ATTR}="${safePath}:${loc.start.line}:${loc.start.column + 1}" ${NAME_ATTR}="${name}"`);
    count++;
  });

  if (!count) return null;
  return { code: s.toString(), map: s.generateMap({ hires: 'boundary', source: file, includeContent: true }), count };
}
