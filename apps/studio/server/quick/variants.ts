/**
 * Design-system props read from the code itself. Components built with
 * class-variance-authority (shadcn/ui and many others) declare their variants
 * in a cva(...) call; when saywright.config.json doesn't describe a component,
 * its variants and defaults come from there, so the Inspector shows them and
 * "make this bigger" or "make it outline" work offline, in any such app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import type { ComponentProp, ComponentSpec } from '../project.ts';

type Node = { type: string; [k: string]: unknown };

/** Sizes from smallest to largest, as design systems name them. */
const SIZE_ORDER = ['2xs', 'xxs', 'xs', 'sm', 'small', 'default', 'md', 'medium', 'base', 'lg', 'large', 'xl', '2xl', 'xxl', '3xl'];
/** Props whose values grow in a direction, so "bigger" and "smaller" step through them. */
const LADDER_PROPS = new Set(['size', 'padding', 'gap', 'spacing', 'scale', 'density', 'radius']);

function ast(code: string): Node | null {
  try {
    return parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true }) as unknown as Node;
  } catch {
    return null;
  }
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type === 'string') visit(n);
  for (const [k, v] of Object.entries(n)) if (k !== 'loc' && k !== 'start' && k !== 'end' && v && typeof v === 'object') walk(v, visit);
}

const keyName = (k: Node | undefined): string | null => (!k ? null : k.type === 'Identifier' ? String(k.name) : k.type === 'StringLiteral' || k.type === 'NumericLiteral' ? String(k.value) : null);

function objectProps(obj: unknown): [string, Node][] {
  const o = obj as Node | undefined;
  if (!o || o.type !== 'ObjectExpression') return [];
  return ((o.properties as Node[]) ?? []).filter((p) => p.type === 'ObjectProperty').flatMap((p) => {
    const k = keyName(p.key as Node);
    return k ? [[k, p.value as Node] as [string, Node]] : [];
  });
}

/** The variants a cva(...) call declares: prop → values, with defaults. */
function readCva(call: Node): ComponentSpec | null {
  const options = (call.arguments as Node[])?.[1];
  const entries = objectProps(options);
  const variants = entries.find(([k]) => k === 'variants')?.[1];
  const defaults = new Map(objectProps(entries.find(([k]) => k === 'defaultVariants')?.[1]).map(([k, v]) => [k, v.type === 'StringLiteral' || v.type === 'NumericLiteral' ? String(v.value) : v.type === 'BooleanLiteral' ? String(v.value) : '']));
  const props: Record<string, ComponentProp> = {};
  for (const [prop, values] of objectProps(variants)) {
    const names = objectProps(values).map(([k]) => k);
    if (!names.length) continue;
    const def: ComponentProp = { values: names };
    // Written as the types read them: `{ true: …, false: … }` is a boolean prop, `{ 1: …, 2: … }` a number.
    const keys = ((values as Node).properties as Node[]).filter((p) => p.type === 'ObjectProperty').map((p) => p.key as Node);
    if (names.every((n) => n === 'true' || n === 'false')) def.type = 'boolean';
    else if (keys.every((k) => k.type === 'NumericLiteral')) def.type = 'number';
    const d = defaults.get(prop);
    if (d) def.default = d;
    if (LADDER_PROPS.has(prop)) {
      const ladder = names.filter((n) => SIZE_ORDER.includes(n)).sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
      if (ladder.length >= 2) {
        def.ordered = true;
        def.ladder = ladder;
      }
    }
    props[prop] = def;
  }
  return Object.keys(props).length ? { text: 'children', props } : null;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The declarations of `component` in the file (`function Alert`, `const Button = forwardRef(…)`), with the types its
 * props are declared by there (`interface ButtonProps extends VariantProps<typeof buttonVariants>`).
 */
function declarationOf(tree: Node, component: string): Node[] {
  const body = ((tree.program as Node | undefined)?.body as Node[] | undefined) ?? [];
  const top = body.map((n) => (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration' ? ((n.declaration as Node | null) ?? n) : n));
  const types = new Map<string, Node>();
  for (const n of top) if ((n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration') && (n.id as Node)?.type === 'Identifier') types.set(String((n.id as Node).name), n);
  const own: Node[] = [];
  for (const n of top) {
    if (n.type === 'FunctionDeclaration' && (n.id as Node | null)?.name === component) own.push(n);
    if (n.type === 'VariableDeclaration') for (const d of (n.declarations as Node[]) ?? []) if ((d.id as Node)?.type === 'Identifier' && (d.id as Node).name === component) own.push(d);
    if (n.type === 'ClassDeclaration' && (n.id as Node | null)?.name === component) own.push(n);
  }
  // The props' types, and the types they name in turn.
  const out = [...own];
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    walk(out[i], (n) => {
      const ref = n.type === 'TSTypeReference' ? (n.typeName as Node) : n.type === 'TSExpressionWithTypeArguments' || n.type === 'TSInterfaceHeritage' ? (n.expression as Node) : null;
      const name = ref?.type === 'Identifier' ? String(ref.name) : null;
      if (name && types.has(name) && !seen.has(name)) {
        seen.add(name);
        out.push(types.get(name)!);
      }
    });
  }
  return own.length ? out : [];
}

/**
 * The cva variants of `component` in a file: of the cva its own declaration uses, by calling it or by naming it in its
 * props' type (`VariantProps<typeof buttonVariants>`). A file declares several components and one cva often serves
 * only one of them (Alert, not AlertTitle): another component of the file is given none, as its types allow none.
 * When the component isn't declared in the file (re-exported from elsewhere), only the cva named after it counts.
 */
export function variantsIn(code: string, component: string): ComponentSpec | null {
  if (!code.includes('cva')) return null;
  const tree = ast(code);
  if (!tree) return null;
  const calls: { name: string | null; call: Node }[] = [];
  walk(tree, (n) => {
    if (n.type !== 'VariableDeclarator') return;
    const init = n.init as Node | undefined;
    const callee = init?.type === 'CallExpression' ? (init.callee as Node) : null;
    if (callee?.type === 'Identifier' && callee.name === 'cva') calls.push({ name: keyName(n.id as Node), call: init! });
  });
  if (!calls.length) return null;
  const named = calls.find((c) => c.name === `${lowerFirst(component)}Variants`);
  const decl = declarationOf(tree, component);
  if (!decl.length) return named ? readCva(named.call) : null;
  const used = new Set<string>();
  for (const d of decl) walk(d, (n) => n.type === 'Identifier' && used.add(String(n.name)));
  const mine = calls.filter((c) => c.name && used.has(c.name));
  const pick = mine.find((c) => c === named) ?? mine[0];
  return pick ? readCva(pick.call) : null;
}

/** JSON with comments and trailing commas (tsconfig.json), as plain JSON. Comment marks inside strings ("@/*") stay. */
export function stripJsonc(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Path aliases from the project's tsconfig (`@/*` → `src/*`). */
function aliases(root: string): [string, string][] {
  const out: [string, string][] = [];
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    try {
      const raw = stripJsonc(fs.readFileSync(path.join(root, name), 'utf8'));
      const opts = (JSON.parse(raw) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
      const base = opts?.baseUrl ?? '.';
      for (const [from, to] of Object.entries(opts?.paths ?? {})) if (from.endsWith('/*') && to[0]?.endsWith('/*')) out.push([from.slice(0, -1), path.posix.join(base, to[0].slice(0, -1)) + '/']);
    } catch {
      /* no such file, or not JSON */
    }
  }
  // The convention, when nothing says otherwise.
  if (!out.length) out.push(['@/', 'src/'], ['~/', 'src/']);
  return out;
}

/** Where `name` used in `fromFile` is defined (a project file), or null for a package. */
export function importedFrom(root: string, fromFile: string, code: string, name: string): string | null {
  const tree = ast(code);
  if (!tree) return null;
  let source: string | null = null;
  walk(tree, (n) => {
    if (source || n.type !== 'ImportDeclaration') return;
    const specs = (n.specifiers as Node[]) ?? [];
    if (specs.some((s) => (s.local as Node)?.name === name)) source = String((n.source as Node).value);
  });
  return source ? resolveImport(root, fromFile, source) : null;
}

/** The project file an import in `fromFile` leads to (a relative path or a tsconfig alias), or null for a package. */
function resolveImport(root: string, fromFile: string, specifier: string): string | null {
  let rel: string | null = null;
  if (specifier.startsWith('.')) rel = path.posix.join(path.posix.dirname(fromFile), specifier);
  else for (const [from, to] of aliases(root)) if (specifier.startsWith(from)) rel = path.posix.normalize(to + specifier.slice(from.length));
  if (!rel) return null;
  for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']) {
    const file = rel + ext;
    try {
      if (fs.statSync(path.join(root, file)).isFile()) return file;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/**
 * The project files `fromFile` imports (or re-exports from), with the names it takes from each. Packages are left
 * out; so are files that aren't code (styles, images).
 */
export function projectImports(root: string, fromFile: string, code: string): { file: string; names: string[] }[] {
  const body = (ast(code)?.program as Node | undefined)?.body;
  const out = new Map<string, string[]>();
  for (const n of Array.isArray(body) ? (body as Node[]) : []) {
    if (n.type !== 'ImportDeclaration' && n.type !== 'ExportNamedDeclaration' && n.type !== 'ExportAllDeclaration') continue;
    const source = (n.source as Node | null)?.value;
    const file = typeof source === 'string' ? resolveImport(root, fromFile, source) : null;
    if (!file || !/\.[cm]?[jt]sx?$/.test(file)) continue;
    const names = ((n.specifiers as Node[] | undefined) ?? []).map((s) => keyName((s.exported as Node) ?? (s.imported as Node)) ?? keyName(s.local as Node) ?? '').filter((x) => x && x !== 'default');
    out.set(file, [...(out.get(file) ?? []), ...names]);
  }
  return [...out].map(([file, names]) => ({ file, names }));
}
