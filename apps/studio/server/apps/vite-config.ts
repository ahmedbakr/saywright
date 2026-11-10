/**
 * An app's Vite config, read with the parser the studio reads the app's code with: where the config's own plugins are
 * listed, and whether the studio's plugin is among them. Text that looks like `plugins: [` can be a PostCSS or Rollup
 * list inside the config, a comment or a string; the list Vite runs is the `plugins` of the object the config exports
 * (given to defineConfig, returned by its function, or exported as it is).
 */
import { parse } from '@babel/parser';

// Babel's tree is loosely typed here on purpose: only a handful of fields are read.
export type Node = any;

/** The Vite plugin's package, as a config imports it. */
export const PLUGIN_PACKAGE = '@saywright/vite';

export interface ViteConfig {
  ast: Node;
  /** Written for CommonJS (a .cjs file, or module.exports): the plugin is an ES module, which such a file can't import. */
  commonjs: boolean;
  /** The name the plugin is imported under (`import saywright from '@saywright/vite'`), when it is. */
  local: string | null;
  /** The `plugins` list of each object the config can be (a function can return several). */
  lists: Node[];
  /** Config objects with no `plugins` at all, when none has a list: where one can be added. */
  bare: Node[];
  /** Why its plugins can't be told for sure, in words for the person; null when they can. */
  unclear: string | null;
}

const SKIP = new Set(['loc', 'start', 'end', 'extra', 'range', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens', 'errors']);

/** Every node under `node`, parents first. A visit that returns false keeps out of that node's children. */
export function walk(node: Node, visit: (n: Node) => boolean | void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === 'string' && visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const v = node[key];
    if (v && typeof v === 'object') walk(v, visit);
  }
}

const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);
/** An expression without what TypeScript or brackets wrap it in, or an `await` before it. */
function unwrap(node: Node): Node {
  while (node && (WRAPPERS.has(node.type) || node.type === 'AwaitExpression')) node = node.type === 'AwaitExpression' ? node.argument : node.expression;
  return node;
}

const isFunction = (n: Node) => n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod';

/** What `const name = …` among these statements sets it to: undefined when they don't declare it, null when they give it no value. */
function declared(statements: Node[], name: string): Node | null | undefined {
  for (const stmt of statements) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type !== 'VariableDeclaration') continue;
    for (const d of decl.declarations) if (d.id?.type === 'Identifier' && d.id.name === name) return d.init ?? null;
  }
  return undefined;
}

/** The objects an exported config can be, added to `out`; or why they can't be told. */
function configObjects(node: Node, scopes: Node[][], seen: Set<Node>, out: Node[]): string | null {
  node = unwrap(node);
  if (!node) return 'its config has no value';
  if (seen.has(node)) return 'its config refers to itself';
  seen.add(node);
  switch (node.type) {
    case 'ObjectExpression':
      out.push(node);
      return null;
    case 'CallExpression': {
      const callee = node.callee;
      const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : null;
      if (name === 'defineConfig' && node.arguments.length) return configObjects(node.arguments[0], scopes, seen, out);
      return `its config is put together by ${name ? `${name}(…)` : 'a function call'}`;
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'FunctionDeclaration': {
      if (node.body.type !== 'BlockStatement') return configObjects(node.body, scopes, seen, out);
      // What this function returns: not what a function written inside it does.
      const returned: Node[] = [];
      walk(node.body.body, (n) => {
        if (isFunction(n) || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return false;
        if (n.type === 'ReturnStatement' && n.argument) returned.push(n.argument);
      });
      if (!returned.length) return 'its config function returns nothing';
      for (const value of returned) {
        const why = configObjects(value, [node.body.body, ...scopes], seen, out);
        if (why) return why;
      }
      return null;
    }
    case 'Identifier': {
      for (const scope of scopes) {
        const init = declared(scope, node.name);
        if (init === undefined) continue;
        return init ? configObjects(init, scopes, seen, out) : `its config (${node.name}) gets its value later in the file`;
      }
      return `its config (${node.name}) comes from another file`;
    }
    case 'ConditionalExpression':
      return configObjects(node.consequent, scopes, seen, out) ?? configObjects(node.alternate, scopes, seen, out);
    default:
      return 'its config isn’t written as an object';
  }
}

/** A config object's own `plugins`: the list, nothing at all (`bare`), or why it can't be told. */
function pluginsOf(obj: Node, src: string): { list: Node } | { bare: true } | { unclear: string } {
  // The last one written is the one that counts.
  for (let i = obj.properties.length - 1; i >= 0; i--) {
    const p = obj.properties[i];
    if (p.type === 'SpreadElement' || p.computed) continue;
    const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
    if (key !== 'plugins') continue;
    const value = p.type === 'ObjectProperty' ? unwrap(p.value) : null;
    if (value?.type === 'ArrayExpression') return { list: value };
    const written = src.slice(p.start, p.end).split('\n')[0].trim();
    return { unclear: `its plugins aren’t written as a list there (${written.length > 60 ? `${written.slice(0, 60)}…` : written})` };
  }
  if (obj.properties.some((p: Node) => p.type === 'SpreadElement')) return { unclear: 'its plugins may come from an object spread into the config' };
  return { bare: true };
}

/** `module.exports` or `exports.name`, being given a value. */
function isCommonJsExport(stmt: Node): boolean {
  if (stmt.type !== 'ExpressionStatement' || stmt.expression.type !== 'AssignmentExpression') return false;
  const left = stmt.expression.left;
  if (left.type !== 'MemberExpression' || left.object.type !== 'Identifier') return false;
  return left.object.name === 'exports' || (left.object.name === 'module' && !left.computed && left.property.name === 'exports');
}

/**
 * Read a Vite config's code. Throws (a SyntaxError, with the line) when the code can't be parsed: Vite couldn't load
 * such a config either.
 */
export function readViteConfig(src: string, file: string): ViteConfig {
  const ast = parse(src, { sourceType: 'module', plugins: /\.[mc]?ts$/.test(file) ? ['typescript'] : [], attachComment: false });
  const body: Node[] = ast.program.body;
  let local: string | null = null;
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== PLUGIN_PACKAGE || stmt.importKind === 'type') continue;
    for (const spec of stmt.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier' || (spec.type === 'ImportSpecifier' && (spec.imported.name ?? spec.imported.value) === 'default')) local = spec.local.name;
    }
  }
  const exported = body.find((s) => s.type === 'ExportDefaultDeclaration');
  const commonjs = /\.c[jt]s$/.test(file) || (!exported && body.some(isCommonJsExport));
  const config: ViteConfig = { ast, commonjs, local, lists: [], bare: [], unclear: null };
  if (commonjs) return config;
  if (!exported) return { ...config, unclear: 'it has no “export default”' };
  const objects: Node[] = [];
  config.unclear = configObjects(exported.declaration, [body], new Set(), objects);
  for (const obj of objects) {
    const found = pluginsOf(obj, src);
    if ('list' in found) config.lists.push(found.list);
    else if ('bare' in found) config.bare.push(obj);
    else config.unclear ??= found.unclear;
  }
  // One of its configs lists its plugins: that list is where they go, not a second one made beside it.
  if (config.lists.length) config.bare = [];
  return config;
}

/**
 * The plugin's calls in a list: among its items, and in those written as a condition (`dev && saywright()`) or
 * spread from a list. Not inside another plugin's options: what is listed there isn't a Vite plugin.
 */
export function pluginCalls(list: Node, local: string): Node[] {
  const out: Node[] = [];
  const look = (item: Node): void => {
    const n = unwrap(item);
    if (!n) return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === local) out.push(n);
    else if (n.type === 'ArrayExpression') n.elements.forEach(look);
    else if (n.type === 'SpreadElement') look(n.argument);
    else if (n.type === 'ConditionalExpression') [n.consequent, n.alternate].forEach(look);
    else if (n.type === 'LogicalExpression') [n.left, n.right].forEach(look);
  };
  list.elements.forEach(look);
  return out;
}

/** Whether the config's own plugins include the studio's plugin, in at least one of the configs it can be. */
export function pluginListed(config: ViteConfig): boolean {
  return !!config.local && config.lists.some((list) => pluginCalls(list, config.local!).length > 0);
}

/**
 * Whether a Vite config's code loads the studio's plugin: imported, and called in the config's own plugins. A mention
 * in a comment or a string doesn't count, nor a call left in a PostCSS or Rollup list. Where the plugins are put
 * together in a way that can't be followed here (a variable, a helper), code that imports the package is believed.
 */
export function loadsPlugin(src: string, file: string): boolean {
  if (!src.includes(PLUGIN_PACKAGE)) return false;
  let config: ViteConfig;
  try {
    config = readViteConfig(src, file);
  } catch {
    // Syntax this parser doesn't know: as before, the package's name in it is taken for the plugin.
    return true;
  }
  if (!config.commonjs && !config.unclear) return pluginListed(config);
  let loaded = false;
  walk(config.ast.program, (n) => {
    if (n.type === 'ImportDeclaration' && n.importKind !== 'type' && n.source.value === PLUGIN_PACKAGE) loaded = true;
    else if ((n.type === 'CallExpression' || n.type === 'ImportExpression') && [n.source, ...(n.arguments ?? [])].some((a: Node) => a?.type === 'StringLiteral' && a.value === PLUGIN_PACKAGE)) {
      loaded ||= n.type === 'ImportExpression' || n.callee.type === 'Import' || (n.callee.type === 'Identifier' && n.callee.name === 'require');
    }
    return !loaded;
  });
  return loaded;
}
