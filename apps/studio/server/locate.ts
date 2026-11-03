/**
 * Where an element was written, for pages that don't say exactly: plain HTML, server templates (PHP, Django,
 * Rails…), other frameworks' templates, and React elements whose development build names the file or the
 * component but not the line. The code is searched for one element that agrees with what the page shows on
 * several counts at once (its tag, text, label, link, id, classes) and contradicts none. Comments, scripts in
 * HTML, imports and plain data (`label: "Save"` in an object) never count, and a word found in many places
 * decides nothing. What a search finds is likely, not certain: callers say so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import type { SourceHint } from '@saywright/vite/protocol';
import { isInside, workspacePackages, workspaceRoot } from '../../../packages/vite/src/workspace.ts';
import type { Project } from './project.ts';

export interface Findable {
  tag?: string;
  text?: string;
  hint?: SourceHint;
}

/**
 * The code a search reads: the app's own files through the studio's shared index of its code (CodeIndex, which
 * Project.search uses too), and in a monorepo the workspace's other packages, walked here.
 */
export interface CodeFiles {
  /** Files relative to the project ("src/App.tsx", "../packages/ui/Button.tsx"), the app's own first. */
  list(): Promise<string[]>;
  read(file: string): Promise<string | null>;
}

/** Files that can hold markup, templates first; scripts last (they build elements too). */
const TEMPLATE = /\.(html?|xhtml|vue|svelte|astro|php|phtml|erb|ejs|hbs|handlebars|mustache|njk|liquid|twig|jinja2?|j2|cshtml|razor|jsp|haml|pug|slim|marko|mdx|md)$/i;
const SCRIPT = /\.([cm]?[jt]sx?)$/i;
/** Not pages: tests, stories and the repository's own documents. */
const NOT_UI = /(^|\/)(__tests__|__mocks__|__snapshots__)\/|\.(test|spec|stories|story)\.[cm]?[jt]sx?$|(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE|CODE_OF_CONDUCT|SECURITY|AGENTS|CLAUDE|HISTORY|NOTICE|AUTHORS)(\.[\w-]+)?\.(md|mdx|txt)$/i;
const MAX_BYTES = 1_000_000;
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'test-results', 'playwright-report', 'vendor', 'storybook-static']);
/** Packages of a workspace that are not part of the app. */
const NOT_APP_PACKAGE = /^(examples?|docs?|website|e2e|tests?|fixtures|benchmarks?|playground|templates?)$/i;

// ─────────────────────────────── the project's files ───────────────────────────────

/** A file that can hold an element of the app's pages (not a build's, a dependency's or a vendored copy's). */
const holdsUi = (file: string) => (TEMPLATE.test(file) || SCRIPT.test(file)) && !NOT_UI.test(file) && !file.split('/').some((part) => IGNORED_DIRS.has(part));

/** Every file under `dir` a search may read, walked without blocking. There is no cap: a big repository is searched whole. */
async function walk(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const subdirs: string[] = [];
  for (const e of entries) {
    // Links can lead outside the project: they are never searched.
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) subdirs.push(abs);
    } else if (TEMPLATE.test(e.name) || SCRIPT.test(e.name)) out.push(abs);
  }
  for (const sub of subdirs) await walk(sub, out);
}

interface Siblings {
  at: number;
  files: Promise<string[]>;
  texts: Map<string, Promise<string | null>>;
}

const siblingsOf = new WeakMap<Project, Siblings>();

/**
 * The project's files and what they say. The app's own come from the project's code index (kept while unchanged);
 * a workspace's other packages are listed and read here, kept for a few seconds: one request points at several
 * elements, and the person keeps editing between requests.
 */
export function projectFiles(project: Project): CodeFiles {
  const ws = workspaceRoot(project.root);
  const packages = ws && ws !== project.root ? workspacePackages(ws).filter((d) => d !== project.root && !isInside(project.root, d) && !isInside(d, project.root) && !NOT_APP_PACKAGE.test(path.basename(d)) && !NOT_APP_PACKAGE.test(path.basename(path.dirname(d)))) : [];
  const inPackages = (abs: string) => packages.some((r) => isInside(r, abs)) && !abs.split(path.sep).includes('node_modules');
  const siblings = (): Siblings => {
    const hit = siblingsOf.get(project);
    if (hit && Date.now() - hit.at < 5000) return hit;
    const files = (async () => {
      const all: string[] = [];
      for (const root of packages) await walk(root, all);
      return all.map((abs) => path.relative(project.root, abs).split(path.sep).join('/')).filter((f) => !NOT_UI.test(f));
    })();
    const fresh = { at: Date.now(), files, texts: new Map() };
    siblingsOf.set(project, fresh);
    return fresh;
  };
  const small = (text: string | null) => (text !== null && text.length <= MAX_BYTES ? text : null);
  return {
    async list() {
      if (!project.hasCode) return [];
      const own = (await project.code.files()).filter(holdsUi);
      return packages.length ? [...own, ...(await siblings().files)] : own;
    },
    read(file) {
      if (!project.hasCode) return Promise.resolve(null);
      const abs = path.resolve(project.root, file);
      if (isInside(project.root, abs)) return project.code.text(path.relative(project.root, abs).split(path.sep).join('/')).then(small, () => null);
      if (!inPackages(abs)) return Promise.resolve(null);
      const { texts } = siblings();
      let text = texts.get(file);
      if (!text) {
        // Links can lead outside the workspace: they are never read.
        text = fs.promises.lstat(abs).then(
          (s) => (s.isFile() && s.size <= MAX_BYTES ? fs.promises.readFile(abs, 'utf8') : null),
          () => null,
        );
        texts.set(file, text);
      }
      return text;
    },
  };
}

/** Read many files, a few at a time. */
async function readAll(files: CodeFiles, list: string[], each: (file: string, text: string) => void): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const file = list[next++];
      const text = await files.read(file);
      if (text !== null) each(file, text);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
}

// ─────────────────────────────── elements written in code ───────────────────────────────

interface Attr {
  /** The value when it is written out ("Save", "/about"). */
  value?: string;
  /** Every string written in it (`className={cn("a b", x && "c")}` → ["a b", "c"]). */
  strings: string[];
  /** The strings it always has, whatever the code decides (["a b"] above; a template's fixed parts). */
  fixed?: string[];
}

/** An element as written in a file: a JSX element, an HTML or template tag, a Markdown block, or a node a script fills. */
interface Written {
  file: string;
  /** Where it starts (its "<", or its line). */
  at: number;
  name: string;
  attrs: Map<string, Attr>;
  /** The text written directly in it, without what code fills in. */
  text: string;
  /** JSX: the functions around it, as [start, end] offsets. */
  scopes?: [number, number][];
  /** Markup: where its start tag ends (its ">"). */
  end?: number;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HTML_TAGS = new Set(
  'a abbr address article aside audio b bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html i iframe img input ins kbd label legend li main map mark menu meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp search section select slot small source span strong sub summary sup table tbody td template textarea tfoot th thead time tr u ul var video wbr svg path g circle rect line polyline polygon ellipse text use image'.split(' '),
);

/** The tag a written name puts in the page, or null for a component ("Button", "el-button", "Card.Title"). */
function intrinsic(name: string): string | null {
  const last = name.includes(':') ? name.split(':').pop()! : name;
  return HTML_TAGS.has(last) ? last : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–', copy: '©' };

/** Text as people read it: entities decoded, invisible characters dropped, spaces collapsed, one kind of quote, lower case. */
function plainText(s: string): string {
  return s
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Blank out what never shows as markup (comments, scripts, styles, front matter, code blocks), keeping offsets. */
function maskMarkup(code: string, file: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  let out = code
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, blank)
    .replace(/\{\{!--[\s\S]*?--\}\}|\{\{![\s\S]*?\}\}|\{#[\s\S]*?#\}|<%#[\s\S]*?%>|\{\/\*[\s\S]*?\*\/\}/g, blank);
  if (/\.(astro|md|mdx)$/i.test(file)) out = out.replace(/^---\r?\n[\s\S]*?\r?\n---/, blank);
  if (/\.(md|mdx)$/i.test(file)) out = out.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1/gm, blank);
  return out;
}

/** The strings written in an expression ("a b" and "c" in `cn("a b", x && "c")`). */
function stringsIn(expr: string): string[] {
  return [...expr.matchAll(/"([^"]*)"|'([^']*)'|`([^`$]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** HTML-like markup: HTML, Vue, Svelte and Astro templates, server templates, markup in a script's string. */
function markupElements(code: string, file: string, base = 0): Written[] {
  const text = maskMarkup(code, file);
  const out: Written[] = [];
  const open: Written[] = [];
  let last = 0;
  const addText = (to: number) => {
    const top = open[open.length - 1];
    if (!top || to <= last) return;
    // What a template fills in ({{ x }}, {x}, <%= x %>, ${x}) isn't written text.
    const chunk = text.slice(last, to).replace(/\{\{[\s\S]*?\}\}|\{[^{}]*\}|<%[\s\S]*?%>|\$\{[^}]*\}/g, ' ');
    if (chunk.trim()) top.text = `${top.text} ${chunk}`.trim();
  };
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)/g;
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    addText(m.index);
    const name = m[2];
    // The end of the tag: the first ">" outside quotes and braces.
    let i = tagRe.lastIndex;
    let quote = '';
    let depth = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === '>' && depth === 0) break;
    }
    const inner = text.slice(tagRe.lastIndex, i);
    last = i + 1;
    tagRe.lastIndex = i + 1;
    if (m[1]) {
      const at = open.map((o) => o.name).lastIndexOf(name);
      if (at >= 0) open.length = at;
      continue;
    }
    const attrs = new Map<string, Attr>();
    const attrRe = /([^\s=/>"'{}]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}|([^\s>]+)))?/g;
    for (let a = attrRe.exec(inner); a; a = attrRe.exec(inner)) {
      // Vue's bound attributes (":title", "v-bind:title") hold code, not their value.
      const bound = /^(?::|v-bind:)/.test(a[1]);
      const key = a[1].replace(/^(?::|v-bind:)/, '');
      const quoted = a[2] ?? a[3];
      const value = bound ? undefined : (quoted ?? a[5]);
      attrs.set(key === 'className' ? 'class' : key, { value, strings: value !== undefined ? [value] : stringsIn(a[4] ?? quoted ?? ''), fixed: value !== undefined ? [value] : undefined });
    }
    const el: Written = { file, at: base + m.index, end: base + i, name, attrs, text: '' };
    out.push(el);
    if (!/\/\s*$/.test(inner) && !VOID.has(name.toLowerCase().split(':').pop()!)) open.push(el);
  }
  return out;
}

/** Markdown: headings, list items, paragraphs, links and images, as the page shows them. */
function markdownElements(code: string, file: string): Written[] {
  const text = maskMarkup(code, file);
  const out: Written[] = [];
  let offset = 0;
  let para: Written | null = null;
  const inline = (s: string) =>
    s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .replace(/<[^>]+>/g, ' ');
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (!line.trim() || /^\s*(:::|<|import\s|export\s)/.test(line)) para = null;
    else if (heading) {
      out.push({ file, at: offset, name: `h${heading[1].length}`, attrs: new Map(), text: inline(heading[2]) });
      para = null;
    } else if (item) {
      out.push({ file, at: offset, name: 'li', attrs: new Map(), text: inline(item[1]) });
      para = null;
    } else if (para) para.text += ` ${inline(line)}`;
    else out.push((para = { file, at: offset, name: 'p', attrs: new Map(), text: inline(line) }));
    for (const link of line.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)/g)) {
      out.push({ file, at: offset + link.index!, name: 'a', attrs: new Map([['href', { value: link[2], strings: [link[2]] }]]), text: inline(link[1]) });
    }
    for (const img of line.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) {
      out.push({ file, at: offset + img.index!, name: 'img', attrs: new Map([['alt', { value: img[1], strings: [img[1]] }]]), text: '' });
    }
    for (const span of line.matchAll(/(\*\*|__)(.+?)\1|(?<![*\w])([*_])(?!\s)(.+?)\3(?![*\w])|`([^`]+)`/g)) {
      const name = span[1] ? 'strong' : span[3] ? 'em' : 'code';
      out.push({ file, at: offset + span.index!, name, attrs: new Map(), text: inline(span[2] ?? span[4] ?? span[5]) });
    }
    offset += line.length + 1;
  }
  return out;
}

// Babel's AST is loosely typed here on purpose: a handful of fields are read.
type Node = any;

function jsxName(n: Node): string | null {
  if (!n) return null;
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`;
  if (n.type === 'JSXMemberExpression') {
    const o = jsxName(n.object);
    return o ? `${o}.${n.property.name}` : null;
  }
  return null;
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments']);

/** The strings inside an expression (`cn("a", x && "b")`, a template's fixed parts), without its code. */
function literalStrings(n: Node, out: string[] = []): string[] {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) {
    for (const c of n) literalStrings(c, out);
    return out;
  }
  if (n.type === 'StringLiteral') out.push(n.value);
  else if (n.type === 'TemplateLiteral') for (const q of n.quasis) out.push(q.value.cooked ?? q.value.raw);
  else for (const key of Object.keys(n)) if (!SKIP_KEYS.has(key) && n[key] && typeof n[key] === 'object') literalStrings(n[key], out);
  return out;
}

/** The strings an expression always yields: a template's fixed parts, a class helper's plain arguments (`cn("a", x && "b")` → "a"). */
function alwaysThere(n: Node): string[] {
  if (!n) return [];
  if (n.type === 'TemplateLiteral') return n.quasis.map((q: Node) => q.value.cooked ?? q.value.raw);
  if (n.type === 'CallExpression') return n.arguments.flatMap((a: Node) => (a.type === 'StringLiteral' ? [a.value] : a.type === 'TemplateLiteral' ? alwaysThere(a) : []));
  return [];
}

const FUNCTION = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod|ClassPrivateMethod|ObjectMethod|ClassDeclaration|ClassExpression)$/;

/** JSX elements in a script, markup it writes in strings, and nodes it fills with text. */
/** What a name stands for in a script: a component written there, or one it imports. */
type Binding = { start: number; end: number } | { from: string; imported: string };

function scriptElements(code: string, file: string, names: Map<string, Binding>): Written[] {
  let ast: Node;
  try {
    ast = parse(code, { sourceType: 'unambiguous', plugins: /\.[cm]?ts$/i.test(file) ? ['typescript'] : ['jsx', 'typescript'], errorRecovery: true });
  } catch {
    return [];
  }
  for (const st of ast.program.body) {
    const decl = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? (st.declaration ?? st) : st;
    if (st.type === 'ImportDeclaration' && /^\./.test(st.source.value)) {
      for (const sp of st.specifiers) if (sp.type !== 'ImportNamespaceSpecifier') names.set(sp.local.name, { from: st.source.value, imported: sp.type === 'ImportDefaultSpecifier' ? 'default' : (sp.imported.name ?? sp.imported.value) });
    } else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) names.set(decl.id.name, { start: decl.start, end: decl.end });
    else if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) if (d.id?.type === 'Identifier' && d.init) names.set(d.id.name, { start: d.init.start, end: d.init.end });
    if (st.type === 'ExportDefaultDeclaration') names.set('default', { start: decl.start, end: decl.end });
  }
  const out: Written[] = [];
  // Markup in strings is what a plain script writes into the page; next to JSX it is for something else (an email, a prompt).
  const inStrings: Written[] = [];
  const scopes: [number, number][] = [];
  const visit = (n: Node): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    const isScope = typeof n.type === 'string' && FUNCTION.test(n.type);
    if (isScope) scopes.push([n.start, n.end]);
    if (n.type === 'JSXElement') {
      const o = n.openingElement;
      const name = jsxName(o.name);
      if (name) {
        const attrs = new Map<string, Attr>();
        for (const a of o.attributes ?? []) {
          const key = a.type === 'JSXAttribute' ? jsxName(a.name) : null;
          if (!key) continue;
          const v = a.value;
          const value = v?.type === 'StringLiteral' ? v.value : v?.type === 'JSXExpressionContainer' && v.expression?.type === 'StringLiteral' ? v.expression.value : undefined;
          attrs.set(key === 'className' ? 'class' : key, { value, strings: value !== undefined ? [value] : literalStrings(v), fixed: value !== undefined ? [value] : alwaysThere(v?.expression) });
        }
        const text = (n.children ?? []).map((c: Node) => (c.type === 'JSXText' ? c.value : c.type === 'JSXExpressionContainer' && c.expression?.type === 'StringLiteral' ? c.expression.value : ' ')).join('');
        out.push({ file, at: n.start, name, attrs, text, scopes: [...scopes] });
      }
    } else if ((n.type === 'StringLiteral' || n.type === 'TemplateLiteral') && /<[a-z][\w-]*[\s>/]/i.test(code.slice(n.start, n.end))) {
      // Markup a script writes into the page (innerHTML, HTML templates).
      inStrings.push(...markupElements(code.slice(n.start + 1, n.end - 1), file, n.start + 1));
    } else if (n.type === 'AssignmentExpression' && n.left?.type === 'MemberExpression' && /^(textContent|innerText)$/.test(n.left.property?.name ?? '') && n.right?.type === 'StringLiteral') {
      // `item.textContent = "A new note"`: the node it fills, made a little earlier with createElement("li").
      const made = /createElement\(\s*['"]([\w-]+)['"]\s*\)(?![\s\S]*createElement\()/.exec(code.slice(Math.max(0, n.start - 300), n.start));
      out.push({ file, at: n.right.start + 1, name: made ? made[1] : '', attrs: new Map(), text: n.right.value });
    }
    for (const key of Object.keys(n)) if (!SKIP_KEYS.has(key) && n[key] && typeof n[key] === 'object') visit(n[key]);
    if (isScope) scopes.pop();
  };
  visit(ast.program);
  return out.some((w) => w.scopes) ? out : [...out, ...inStrings];
}

const parsed = new Map<string, { code: string; els: Written[]; names: Map<string, Binding> }>();

function parsedFile(file: string, code: string): { els: Written[]; names: Map<string, Binding> } {
  const hit = parsed.get(file);
  if (hit && hit.code === code) return hit;
  const names = new Map<string, Binding>();
  const els = SCRIPT.test(file) ? scriptElements(code, file, names) : /\.mdx?$/i.test(file) ? [...markdownElements(code, file), ...(/\.mdx$/i.test(file) ? markupElements(code, file) : [])] : markupElements(code, file);
  if (parsed.size >= 400) parsed.delete(parsed.keys().next().value!);
  const entry = { code, els, names };
  parsed.set(file, entry);
  return entry;
}

/** The elements written in a file (kept while the file stays the same). */
function elementsOf(file: string, code: string): Written[] {
  return parsedFile(file, code).els;
}

// ─────────────────────────────── agreeing with the page ───────────────────────────────

/** Values that say nothing about which element it is. */
const GENERIC = /^(on|off|true|false|yes|no|none|null|undefined|#|\/|[\d\s.,:%+×x-]+|.)$/i;
/** Classes that style many things: utilities, generated names, scoped-style markers, states. */
const UTILITY = /[:[\]/]|^(svelte-|css-|sc-|jsx-|astro-|v-)|(?<!_)_(?=[a-zA-Z0-9]*[A-Z0-9])[a-zA-Z0-9]{4,6}$|^-?(flex|grid|block|inline|hidden|contents|static|relative|absolute|fixed|sticky|p[xytrbl]?-|m[xytrbl]?-|w-|h-|min-|max-|size-|gap-|space-|text-|font-|leading-|tracking-|bg-|border|rounded|shadow|ring|outline|opacity-|z-|top-|left-|right-|bottom-|inset|items-|justify-|self-|place-|content-|order-|col-(?:span|start|end|auto)|row-(?:span|start|end|auto)|overflow|truncate|whitespace|break-|cursor-|select-|pointer-|transition|duration-|ease-|animate-|scale-|rotate-|translate-|origin-|fill-|stroke-|sr-only|container$|group|peer|dark$|active$|disabled$|selected$|open$|show$|hide$|visible$|invisible$|is-|has-)/;

const ID_ATTRS = ['id', 'data-testid', 'data-test', 'data-cy', 'data-qa'];
/** Ids a library makes up at run time (React's useId, Radix, Headless UI…): they are in no file. */
const MADE_UP_ID = /:r[\w]*:|«r\w*»|^(radix|headlessui|react-aria|mui|downshift|rc-|chakra)[-_:]|^[\w-]*\d{3,}$/i;
const LABEL_ATTRS = ['aria-label', 'title', 'alt', 'placeholder', 'name', 'for'];
const LINK_ATTRS = ['href', 'src', 'action'];

/** Components whose name says the tag they render: <Link> is an a, <Button> a button. */
function standsFor(name: string, tag: string): boolean {
  const n = name.split('.').pop()!.toLowerCase();
  const words: Record<string, string[]> = { a: ['link', 'anchor'], img: ['image', 'img', 'picture', 'avatar'], svg: ['icon', 'logo', 'svg'], button: ['button', 'btn', 'trigger'], input: ['input', 'field', 'checkbox', 'radio', 'switch'], label: ['label'], textarea: ['textarea'], select: ['select'], li: ['item'] };
  if (/^h[1-6]$/.test(tag)) return /heading|title$/.test(n);
  return n === tag || (words[tag] ?? []).some((w) => n.endsWith(w)) || (tag === 'a' && n.startsWith('link'));
}

/** The same link, written relative or not: another site's address never matches a path of this one. */
const sameLink = (a: string, b: string) => {
  const host = (s: string) => /^(?:https?:)?\/\/([^/]+)/i.exec(s)?.[1]?.toLowerCase() ?? null;
  if (host(a) !== host(b) && host(a) && host(b)) return false;
  if (!!host(a) !== !!host(b) && ![a, b].some((s) => /^(?:https?:)?\/\/(localhost|127\.0\.0\.1)\b/i.test(s))) return false;
  const clean = (s: string) =>
    s
      .replace(/^(?:https?:)?\/\/[^/]+/i, '')
      .replace(/^\.?\/+/, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  const x = clean(a);
  const y = clean(b);
  return x === y || (!!x && !!y && (x.endsWith(`/${y}`) || y.endsWith(`/${x}`)));
};

/** Whether `words` appear in `text` as whole words. */
const hasWords = (text: string, words: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text);

interface Score {
  points: number;
  /** Which kinds of signal agree: id, text, label, link, class, tag. */
  kinds: Set<string>;
  classes: string[];
}

/** How well an element written in code agrees with the one on the page; null when it contradicts it. */
function score(w: Written, el: Findable, text: string): Score | null {
  const attrs = el.hint?.attrs ?? {};
  const tag = (el.tag ?? '').toLowerCase();
  const kinds = new Set<string>();
  let points = 0;
  const own = intrinsic(w.name);
  if (tag && own) {
    if (own !== tag) return null;
    kinds.add('tag');
    points += 2;
  } else if (tag && w.name && standsFor(w.name, tag)) {
    kinds.add('tag');
    points += 1;
  }
  for (const k of ID_ATTRS) {
    const mine = w.attrs.get(k)?.value;
    if (!attrs[k] || mine === undefined || MADE_UP_ID.test(attrs[k])) continue;
    if (mine !== attrs[k]) return null;
    kinds.add('id');
    points += 10;
  }
  for (const k of LABEL_ATTRS) {
    const mine = w.attrs.get(k)?.value;
    if (!attrs[k] || mine === undefined || GENERIC.test(attrs[k])) continue;
    if (plainText(mine) !== plainText(attrs[k])) return null;
    kinds.add('label');
    points += 3;
  }
  for (const k of LINK_ATTRS) {
    const mine = w.attrs.get(k)?.value;
    if (attrs[k] && mine !== undefined && !GENERIC.test(attrs[k]) && sameLink(mine, attrs[k])) {
      kinds.add('link');
      points += 3;
    }
  }
  const written = plainText(w.text);
  // The page sends long text cut short ("…"): its start, without the word it cut through.
  const cut = text.endsWith('…');
  if (cut) text = text.slice(0, -1).replace(/\s*\S*$/, '');
  if (text && written && !GENERIC.test(written)) {
    const part = (!cut && hasWords(text, written) && written.length >= Math.max(3, text.length * 0.3)) || (hasWords(written, text) && text.length >= 3);
    const whole = written === text || (cut && part && text.length >= 20);
    if (whole || part) {
      kinds.add('text');
      points += whole ? 4 : 2;
      // Other words written right there: not this element.
    } else if (written.length >= 3 && /\p{L}/u.test(written)) return null;
  }
  const shown = (attrs.class ?? '').split(/\s+/).filter(Boolean);
  const cls = w.attrs.get('class');
  // A class it always has that the page's element hasn't: another element (when the page sent all its classes).
  const always = (cls?.fixed ?? []).flatMap((s) => s.split(/\s+/)).filter((c) => c && !UTILITY.test(c) && !/[{}$]/.test(c));
  if (shown.length && shown.length < 12 && (attrs.class ?? '').length < 190 && always.some((c) => !shown.includes(c))) return null;
  const mine = new Set((cls?.strings ?? []).flatMap((s) => s.split(/\s+/)));
  const classes = shown.filter((c) => !UTILITY.test(c) && mine.has(c));
  if (classes.length) {
    kinds.add('class');
    points += Math.min(3, classes.length);
  }
  return { points, kinds, classes };
}

/** Enough agreement to name it: an id, or two kinds of signal of which one is something it says or links to. */
function agrees(s: Score, uniqueClass: boolean): boolean {
  if (s.kinds.has('id')) return true;
  const said = ['text', 'label', 'link'].some((k) => s.kinds.has(k));
  if (said && s.kinds.size >= 2) return true;
  // A tag and a class written nowhere else, with nothing to contradict.
  return uniqueClass && s.kinds.has('tag') && s.kinds.has('class');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What is worth looking for in a file at all: files with none of it are not parsed. */
function needles(el: Findable): RegExp | null {
  const attrs = el.hint?.attrs ?? {};
  const values = [...ID_ATTRS.filter((k) => !MADE_UP_ID.test(attrs[k] ?? '')), ...LABEL_ATTRS, ...LINK_ATTRS].map((k) => attrs[k]).filter((v): v is string => !!v && v.length >= 2 && !GENERIC.test(v));
  const text = (el.text ?? '').trim();
  if (text.length >= 2 && !GENERIC.test(text)) values.push(text.split(/\s+/).slice(0, 4).join(' '));
  for (const c of (attrs.class ?? '').split(/\s+/)) if (c.length >= 3 && !UTILITY.test(c)) values.push(c);
  if (!values.length) return null;
  // Text may be written with other spacing, entities or quotes, and words emphasised (**small**, <em>small</em>).
  const pattern = values.map((v) =>
    escape(v.slice(0, 40))
      .replace(/\s+/g, '(?:\\s|[*_~`]|<[^>]*>)+')
      .replace(/['’]/g, "(?:['’]|&rsquo;|&#39;|&#x27;|&apos;)")
      .replace(/&/g, '&(?:amp;)?'),
  );
  return new RegExp(pattern.join('|'), 'i');
}

function lineCol(text: string, index: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return { line, col: index - last };
}

/** The page's own file for a static site: /about → about.html, /docs/ → docs/index.html. */
function pageFiles(pageUrl: string | undefined): string[] {
  if (!pageUrl) return [];
  let p: string;
  try {
    p = decodeURIComponent(new URL(pageUrl).pathname).replace(/^\/+/, '');
  } catch {
    return [];
  }
  if (!p || p.endsWith('/')) return [`${p}index.html`, `${p}index.htm`];
  if (path.extname(p)) return [p];
  return [`${p}.html`, `${p}/index.html`];
}

/** A file a framework named (absolute, or relative to the project) → relative to the project. */
function projectPath(root: string, file: string): string {
  const clean = file.replace(/^file:\/\//, '').replace(/[?#].*$/, '');
  const abs = path.isAbsolute(clean) ? clean : path.join(root, clean);
  return path.relative(root, abs).split(path.sep).join('/');
}

interface Candidate {
  w: Written;
  s: Score;
  /** 0: a file named for it, 1: the app's own, 2: another package of the workspace. */
  rank: number;
}

/** The one element that agrees best, or null when none agrees enough or two agree equally well (that would be a guess). */
function best(candidates: Candidate[]): Candidate | null {
  const counts = new Map<string, number>();
  for (const c of candidates) for (const cls of c.s.classes) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  // Text found in many places (a common word) decides nothing.
  const common = candidates.filter((c) => c.s.kinds.has('text')).length > 3;
  const ok = candidates
    .map((c) => (common && c.s.kinds.has('text') ? { ...c, s: { ...c.s, points: c.s.points - 2, kinds: new Set([...c.s.kinds].filter((k) => k !== 'text')) } } : c))
    .filter((c) => agrees(c.s, c.s.classes.some((cls) => counts.get(cls) === 1)));
  ok.sort((a, b) => b.s.points - a.s.points || a.rank - b.rank);
  const [first, second] = ok;
  if (!first || (second && second.s.points === first.s.points && second.rank === first.rank)) return null;
  return first;
}

/**
 * Where an element is written, found by what the page shows of it, or null when nothing agrees enough. A file a
 * framework named for it (`hint.file`: a Vue component's) and the page's own file (a static site's) come first.
 */
export async function locateElement(files: CodeFiles, el: Findable, opts: { pageUrl?: string; root?: string } = {}): Promise<string | null> {
  const needle = needles(el);
  if (!needle) return null;
  const text = plainText(el.text ?? '');
  const all = await files.list();
  const named = [el.hint?.file && opts.root ? projectPath(opts.root, el.hint.file) : null, ...pageFiles(opts.pageUrl)].filter((f): f is string => !!f && all.includes(f));
  const rank = (f: string) => (named.includes(f) ? 0 : f.startsWith('../') ? 2 : 1);
  const candidates: Candidate[] = [];
  const texts = new Map<string, string>();
  await readAll(files, all, (file, code) => {
    if (!needle.test(code)) return;
    texts.set(file, code);
    for (const w of elementsOf(file, code)) {
      const s = score(w, el, GENERIC.test(text) ? '' : text);
      if (s && s.points > 0) candidates.push({ w, s, rank: rank(file) });
    }
  });
  const pick = best(candidates);
  if (!pick) return null;
  const { line, col } = lineCol(texts.get(pick.w.file)!, pick.w.at);
  return `${pick.w.file}:${line}:${col}`;
}

/**
 * The JSX element called `name` (a tag, or a component: "IconButton") in `file`, for a place React named without
 * its line: inside the component around `near` (React 19.0 says where a component is), or anywhere in the file
 * (webpack's eval'd modules). `sure` when only one fits; otherwise the one agreeing best with the page, or null.
 */
export async function findWritten(files: CodeFiles, file: string, name: string, el: Findable, near?: { line: number; col: number }): Promise<{ src: string; sure: boolean } | null> {
  const code = await files.read(file);
  if (code === null) return null;
  const all = elementsOf(file, code);
  // As written, or by its last part (<Menu.Item>); a library's display name can be longer (DropdownMenuItem for <Primitive.Item>).
  let els = all.filter((w) => w.name === name || w.name.split('.').pop() === name);
  if (!els.length) els = all.filter((w) => !intrinsic(w.name) && w.name.split('.').pop()!.length >= 3 && name.endsWith(w.name.split('.').pop()!));
  if (near) {
    const lines = code.split('\n');
    const offset = lines.slice(0, near.line - 1).reduce((n, l) => n + l.length + 1, 0) + near.col - 1;
    // The innermost function around that place that writes it: the component (for a class, the class).
    const around = els.flatMap((w) => w.scopes ?? []).filter(([s, e]) => s <= offset && offset <= e);
    const scope = around.sort((a, b) => b[0] - a[0])[0];
    els = scope ? els.filter((w) => w.at >= scope[0] && w.at <= scope[1]) : [];
  }
  if (!els.length) return null;
  if (els.length === 1) {
    const { line, col } = lineCol(code, els[0].at);
    return { src: `${file}:${line}:${col}`, sure: true };
  }
  return pickWritten(code, file, els, el, true);
}

/** The JSX called `name` among `els`, by what the page shows when several fit; `sure` when one does or one is told apart. */
function pickWritten(code: string, file: string, els: Written[], el: Findable, needSignal: boolean): { src: string; sure: boolean } | null {
  const at = (w: Written) => {
    const { line, col } = lineCol(code, w.at);
    return `${file}:${line}:${col}`;
  };
  const text = plainText(el.text ?? '');
  const scored = els.map((w) => ({ w, s: score(w, { ...el, tag: undefined }, text) })).filter((x): x is { w: Written; s: Score } => !!x.s && (x.s.points > 0 || (!needSignal && els.length === 1)));
  scored.sort((a, b) => b.s.points - a.s.points);
  const [first, second] = scored;
  if (!first || (second && second.s.points === first.s.points)) return null;
  if (els.length === 1 && !needSignal) return { src: at(first.w), sure: true };
  // Picked by an id, label or link only it has: as good as told.
  const telling = (s: Score) => ['id', 'label', 'link'].some((k) => s.kinds.has(k));
  return { src: at(first.w), sure: telling(first.s) && !(second && telling(second.s)) };
}

/** A relative import's file, as a bundler resolves it ("./Header" → "./Header.tsx" or "./Header/index.tsx"). */
async function imported(files: CodeFiles, from: string, spec: string): Promise<{ file: string; code: string } | null> {
  const base = path.posix.join(path.posix.dirname(from), spec);
  for (const file of [base, ...['.tsx', '.ts', '.jsx', '.js', '.mjs'].map((e) => base + e), ...['.tsx', '.ts', '.jsx', '.js'].map((e) => `${base}/index${e}`)]) {
    if (!SCRIPT.test(file)) continue;
    const code = await files.read(file);
    if (code !== null) return { file, code };
  }
  return null;
}

/**
 * The element `tag` inside the definition of the component written as `<component>` in `file` (there, or in the
 * file it imports it from): where React 19.0 couldn't say where a component is, its use leads to it. Needs the page
 * to agree (its text, a label, a link, a class): a component's JSX is not the element because it has the same tag.
 */
export async function findInComponent(files: CodeFiles, file: string, component: string, tag: string, el: Findable): Promise<{ src: string; sure: boolean } | null> {
  let where = file;
  let code = await files.read(file);
  let name = component.split('.').pop()!;
  for (let hops = 0; code !== null && hops < 3; hops++) {
    const { names } = parsedFile(where, code);
    const b = names.get(name);
    if (!b) return null;
    if ('start' in b) {
      const els = elementsOf(where, code).filter((w) => w.name === tag && w.at >= b.start && w.at <= b.end);
      return els.length ? pickWritten(code, where, els, el, true) : null;
    }
    const next = await imported(files, where, b.from);
    if (!next) return null;
    ({ file: where, code } = next);
    name = b.imported;
  }
  return null;
}

/**
 * A position a template framework reports inside an element's start tag (Astro gives where it ends) → where the tag
 * starts, or null when it isn't in one. JSX and scripts are left as they are.
 */
export async function startOfTag(files: CodeFiles, file: string, line: number, col: number): Promise<string | null> {
  if (SCRIPT.test(file) || !TEMPLATE.test(file)) return null;
  const code = await files.read(file);
  if (code === null) return null;
  const offset = code.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
  const els = elementsOf(file, code).filter((w) => w.end !== undefined && w.at <= offset && offset <= w.end + 1);
  const tag = els.sort((a, b) => b.at - a.at)[0];
  if (!tag || tag.at === offset) return null;
  const at = lineCol(code, tag.at);
  return `${file}:${at.line}:${at.col}`;
}

/** Whether a path relative to the project is the app's or its workspace's own code (not a library's). */
export function inProject(root: string, file: string): boolean {
  const abs = path.resolve(root, file);
  if (abs.split(path.sep).includes('node_modules')) return false;
  if (isInside(root, abs)) return true;
  const ws = workspaceRoot(root);
  return !!ws && isInside(ws, abs);
}
