/**
 * Small, careful edits to an app's own source files (used by `saywright connect`). Where to edit is found with the
 * parser, never by text that looks right; the result is read again before it is handed back, and an edit that can't
 * be made safely is refused with the reason, so the caller changes nothing and says how to do it by hand.
 */
import { parse } from '@babel/parser';
import { PLUGIN_PACKAGE, pluginCalls, pluginListed, readViteConfig, walk, type Node, type ViteConfig } from '../server/apps/vite-config.ts';

/** A file's new text, or why it is left as it is (in words for the person). */
export type Edit = { code: string } | { refused: string };

interface Change {
  at: number;
  /** How many characters go, from `at`. */
  remove?: number;
  text: string;
}

/** Apply changes made against the same text, last first, so each one's place still holds. */
function apply(src: string, changes: Change[]): string {
  let out = src;
  for (const c of [...changes].sort((a, b) => b.at - a.at)) out = out.slice(0, c.at) + c.text + out.slice(c.at + (c.remove ?? 0));
  return out;
}

/** The file's own line ending: Windows' where it uses them. */
const eolOf = (src: string) => (src.includes('\r\n') ? '\r\n' : '\n');
/** Where the line holding `at` starts, and where it ends (before its line break). */
const lineStart = (src: string, at: number) => src.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (src: string, at: number) => {
  const nl = src.indexOf('\n', at);
  const end = nl < 0 ? src.length : nl;
  return src[end - 1] === '\r' ? end - 1 : end;
};
/** Where the line after the one holding `at` starts. */
const nextLine = (src: string, at: number) => {
  const nl = src.indexOf('\n', at);
  return nl < 0 ? src.length : nl + 1;
};
const indentAt = (src: string, at: number) => /^[ \t]*/.exec(src.slice(lineStart(src, at)))![0];
/** One more level of the indentation a line uses: a tab where it uses tabs. */
const deeper = (indent: string) => indent + (indent.includes('\t') ? '\t' : '  ');

const parseModule = (src: string): Node => parse(src, { sourceType: 'module', plugins: ['typescript'], attachComment: false });

/** Where a new import goes, and how to write it there: after the file's own imports, on a line of its own. */
function importChange(src: string, ast: Node, line: string): Change {
  const eol = eolOf(src);
  const imports = (ast.program.body as Node[]).filter((s) => s.type === 'ImportDeclaration');
  if (imports.length) return { at: lineEnd(src, imports[imports.length - 1].end), text: `${eol}${line}` };
  // No imports: after what must stay first. A `#!` line and 'use client' do; so does a /// <reference> directive, and
  // a comment that stands apart from the code below it (a licence). A comment right above the code is about that code.
  let at = 0;
  if (ast.program.interpreter) at = nextLine(src, ast.program.interpreter.end);
  const directives: Node[] = ast.program.directives ?? [];
  if (directives.length) at = nextLine(src, directives[directives.length - 1].end);
  const code = ast.program.body[0]?.start ?? src.length;
  const comments = ((ast.comments ?? []) as Node[]).filter((c) => c.start >= at && c.end <= code);
  comments.forEach((c, i) => {
    const gap = src.slice(c.end, comments[i + 1]?.start ?? code);
    if (src.startsWith('///', c.start) || /\n[ \t]*\r?\n/.test(gap)) at = nextLine(src, c.end);
  });
  return { at, text: at > 0 && src[at - 1] !== '\n' ? `${eol}${line}${eol}` : `${line}${eol}` };
}

/**
 * Add an import after the file's own imports: what must stay first (`/// <reference types>` directives,
 * 'use client', a licence comment) stays first. Without imports, after those.
 */
export function addImport(src: string, line: string, ast: Node = parseModule(src)): string {
  return apply(src, [importChange(src, ast, line)]);
}

/** `import saywright from '@saywright/vite'` in the file's own style: its quotes, and no semicolon where it writes none. */
function pluginImport(src: string, ast: Node, name: string): string {
  const body: Node[] = ast.program.body;
  const imports = body.filter((s) => s.type === 'ImportDeclaration');
  const quotes = imports.map((i) => src[i.source.start]);
  const q = quotes.includes('"') && !quotes.includes("'") ? '"' : "'";
  const ends = (imports.length ? imports : body).map((s) => src[s.end - 1] === ';');
  const semi = ends.includes(false) && !ends.includes(true) ? '' : ';';
  return `import ${name} from ${q}${PLUGIN_PACKAGE}${q}${semi}`;
}

/** The plugin's call as the first item of a list, written as the list writes its items: one a line where it does. */
function listChange(src: string, list: Node, call: string): Change {
  const first = (list.elements as Node[]).find(Boolean);
  if (!first) {
    // An empty list: `[]` becomes `[saywright()]`; a comment in it stays where it is.
    const inside = src.slice(list.start + 1, list.end - 1);
    if (!inside.trim()) return { at: list.start + 1, remove: inside.length, text: call };
    return { at: list.start + 1, text: /^\s/.test(inside) ? call : `${call} ` };
  }
  const indent = src.slice(lineStart(src, first.start), first.start);
  return { at: first.start, text: /^[ \t]*$/.test(indent) && lineStart(src, first.start) > list.start ? `${call},${eolOf(src)}${indent}` : `${call}, ` };
}

/** A `plugins` list with the plugin's call, added to a config object that has none. */
function propertyChange(src: string, obj: Node, call: string): Change {
  const first = obj.properties[0];
  if (!first) {
    // `{}` becomes `{ plugins: [saywright()] }`; a comment in it stays where it is.
    const inside = src.slice(obj.start + 1, obj.end - 1);
    return inside.trim() ? { at: obj.start + 1, text: ` plugins: [${call}],` } : { at: obj.start + 1, remove: inside.length, text: ` plugins: [${call}] ` };
  }
  const indent = src.slice(lineStart(src, first.start), first.start);
  return { at: first.start, text: /^[ \t]*$/.test(indent) && lineStart(src, first.start) > obj.start ? `plugins: [${call}],${eolOf(src)}${indent}` : `plugins: [${call}], ` };
}

/**
 * What versions before 0.3.0 could leave behind: `saywright(), ` put after the first text that read `plugins: [`,
 * which could be a PostCSS or Rollup list inside the config, a comment or a string. Where that isn't one of the
 * config's own lists, the call is taken out again, as it was put in.
 */
function misplacedCall(src: string, config: ViteConfig): Change | null {
  if (config.local !== 'saywright') return null;
  const m = /plugins\s*:\s*\[/.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  if (config.lists.some((list) => list.start === open)) return null;
  const call = /^(\s*)saywright\(\)\s*,( ?)(\r?\n[ \t]*)?/.exec(src.slice(open + 1));
  if (!call) return null;
  // On a line of its own, the line goes with it; among others on one line, the space after its comma does.
  const ownLine = call[1].includes('\n') && call[3] !== undefined;
  return { at: open + 1 + call[1].length, remove: call[0].length - call[1].length - (ownLine ? 0 : (call[3]?.length ?? 0)), text: '' };
}

/** Lists named `plugins` that aren't the config's own, and still hold the plugin's call. */
function strayCalls(config: ViteConfig): number {
  if (!config.local) return 0;
  let count = 0;
  walk(config.ast.program, (n) => {
    if (n.type !== 'ObjectProperty' || n.computed || n.value.type !== 'ArrayExpression' || config.lists.includes(n.value)) return;
    if ((n.key.name ?? n.key.value) === 'plugins') count += pluginCalls(n.value, config.local!).length;
  });
  return count;
}

export type PluginEdit =
  /** The plugin is in the config's own plugins already. */
  | { kind: 'present' }
  /** The config with the plugin added; `repaired` when an earlier version had left its call in the wrong place. */
  | { kind: 'edit'; code: string; repaired: boolean }
  /** Left as it is, and why; `commonjs` when the reason is that the config isn't an ES module. */
  | { kind: 'manual'; why: string; commonjs?: boolean };

/**
 * Add `saywright()` to a Vite config's own plugins, first in the list, with its import, in the config's style. The
 * result is parsed again: unless the plugin is then in every list Vite can be given, nothing is handed back to write.
 */
export function addVitePlugin(src: string, file: string): PluginEdit {
  let config: ViteConfig;
  try {
    config = readViteConfig(src, file);
  } catch (err) {
    return { kind: 'manual', why: `it couldn’t be read (${err instanceof Error ? err.message : err})` };
  }
  if (config.commonjs) return { kind: 'manual', commonjs: true, why: 'it is a CommonJS file (require and module.exports), and the plugin needs an ES module config' };
  if (config.unclear) return { kind: 'manual', why: config.unclear };
  const undo = misplacedCall(src, config);
  if (pluginListed(config)) {
    // In the right list already; a second call an earlier version left in another one still goes.
    const code = undo ? apply(src, [undo]) : src;
    return undo && pluginListed(readViteConfig(code, file)) ? { kind: 'edit', code, repaired: true } : { kind: 'present' };
  }
  if (!config.lists.length && !config.bare.length) return { kind: 'manual', why: 'its config has no plugins list' };

  const changes: Change[] = [];
  let name = config.local;
  if (!name) {
    name = 'saywright';
    // The name is taken (another import, a variable): which one a call would mean can't be left to chance.
    let taken = src.includes(PLUGIN_PACKAGE) && (config.ast.program.body as Node[]).some((s) => s.type === 'ImportDeclaration' && s.importKind !== 'type' && s.source.value === PLUGIN_PACKAGE);
    walk(config.ast.program, (n) => {
      if ((n.type === 'VariableDeclarator' || n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id?.type === 'Identifier' && n.id.name === name) taken = true;
      if (/^Import.*Specifier$/.test(n.type) && n.local.name === name) taken = true;
    });
    if (taken) return { kind: 'manual', why: `it already uses the name ${name}, or imports ${PLUGIN_PACKAGE} under no name of its own` };
    changes.push(importChange(src, config.ast, pluginImport(src, config.ast, name)));
  }
  const call = `${name}()`;
  for (const list of config.lists) changes.push(listChange(src, list, call));
  for (const obj of config.bare) changes.push(propertyChange(src, obj, call));
  if (undo) changes.push(undo);

  const code = apply(src, changes);
  let after: ViteConfig;
  try {
    after = readViteConfig(code, file);
  } catch {
    return { kind: 'manual', why: 'adding it would have left the config unreadable' };
  }
  const everywhere = !!after.local && !after.unclear && after.lists.length === config.lists.length + config.bare.length && after.lists.every((list) => pluginCalls(list, after.local!).length > 0);
  if (!everywhere) return { kind: 'manual', why: 'its plugins couldn’t be changed safely' };
  if (strayCalls(after)) return { kind: 'manual', why: `${call} is also in a plugins list that isn’t the config’s own (take it out of that one)` };
  return { kind: 'edit', code, repaired: !!config.local };
}

/** The names `Head` goes by in a pages/_document: as imported from next/document, whatever it is called there. */
function headNames(ast: Node): string[] {
  const names: string[] = [];
  for (const stmt of ast.program.body as Node[]) {
    if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== 'next/document') continue;
    for (const spec of stmt.specifiers) if (spec.type === 'ImportSpecifier' && (spec.imported.name ?? spec.imported.value) === 'Head') names.push(spec.local.name);
  }
  return names.length ? names : ['Head'];
}

/** The elements a Next.js file's script tag goes in: `<body>` in a root layout, `<Head>` in pages/_document. */
function hosts(ast: Node, where: 'body' | 'head'): Node[] {
  const names = where === 'body' ? ['body'] : headNames(ast);
  const found: Node[] = [];
  walk(ast.program, (n) => {
    if (n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier' && names.includes(n.openingElement.name.name)) found.push(n);
  });
  return found;
}

/**
 * Put `tag` (a JSX expression) first inside a Next.js root layout's `<body>` or a pages/_document's `<Head>`, on a
 * line of its own, indented like what follows. The tag's place is where the parser says the element opens, so an
 * arrow function or a comparison in its attributes isn't taken for its end; a `<Head />` that closes itself is opened.
 */
export function addJsxScript(src: string, where: 'body' | 'head', tag: string): Edit {
  const read = (code: string): Node => parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], attachComment: false });
  let ast: Node;
  try {
    ast = read(src);
  } catch (err) {
    return { refused: `it couldn’t be read (${err instanceof Error ? err.message : err})` };
  }
  const targets = hosts(ast, where);
  if (!targets.length) return { refused: where === 'body' ? 'it has no <body>' : 'it has no <Head>' };
  const eol = eolOf(src);
  const changes = targets.map((el): Change => {
    const open = el.openingElement;
    const indent = indentAt(src, open.start);
    if (open.selfClosing) {
      const name = src.slice(open.name.start, open.name.end);
      const opened = src.slice(open.start, open.end).replace(/\s*\/>$/, '>');
      return { at: open.start, remove: open.end - open.start, text: `${opened}${eol}${deeper(indent)}${tag}${eol}${indent}</${name}>` };
    }
    // What it holds starts on the next line: the tag gets a line of its own before it, indented the same.
    const below = /^[ \t]*\r?\n([ \t]*)(\S?)/.exec(src.slice(open.end));
    if (below) return { at: open.end, text: `${eol}${below[2] && !src.startsWith('</', open.end + below[0].length - 1) ? below[1] : deeper(indent)}${tag}` };
    return { at: open.end, text: `${eol}${deeper(indent)}${tag}${eol}${deeper(indent)}` };
  });
  const code = apply(src, changes);
  try {
    const now = hosts(read(code), where);
    const holds = (el: Node) => (el.children as Node[]).some((c) => c.type === 'JSXExpressionContainer' && code.slice(c.start, c.end) === tag);
    if (now.length !== targets.length || !now.every(holds)) return { refused: 'the script tag couldn’t be added safely' };
  } catch {
    return { refused: 'adding the script tag would have left it unreadable' };
  }
  return { code };
}

/**
 * Put `lines` (the studio's script tag, under its comment) first in an HTML page's head: after `<head>`, or in a
 * page written without one after `<html>` or the doctype, where a browser still reads them as the head. A `<head>`
 * inside a comment isn't one.
 */
export function addPageScript(src: string, lines: string[]): Edit {
  const eol = eolOf(src);
  const page = src.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
  const after = (tag: RegExp) => {
    const m = tag.exec(page);
    return m ? m.index + m[0].length : null;
  };
  const head = after(/<head(?:\s[^>]*)?>/i);
  const at = head ?? after(/<html(?:\s[^>]*)?>/i) ?? after(/<!doctype[^>]*>/i) ?? 0;
  let text: string;
  if (at === 0) text = `${lines.join(eol)}${eol}`;
  else {
    // What follows starts on a later line: the tag is indented like it. On the same line: the tag gets lines of its
    // own (four spaces in, inside a <head>), and what follows goes on after them.
    const below = /^[ \t]*\r?\n(?:[ \t]*\r?\n)*([ \t]*)\S/.exec(src.slice(at));
    const indent = below ? below[1] : head === null ? '' : '    ';
    text = lines.map((l) => `${eol}${indent}${l}`).join('') + (below ? '' : `${eol}${head === null ? '' : indentAt(src, at)}`);
  }
  const code = apply(src, [{ at, text }]);
  return lines.every((l) => code.includes(l)) && code !== src ? { code } : { refused: 'the script tag couldn’t be added' };
}
