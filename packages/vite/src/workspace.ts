/**
 * The workspace (monorepo) an app belongs to. npm, yarn and pnpm workspaces, Lerna, Nx, Turborepo and Rush keep an
 * app's components in sibling packages (apps/web next to packages/ui), so the plugin annotates those files too and
 * the studio reads and edits them, by paths relative to the app's folder ("../packages/ui/Button.tsx").
 */
import fs from 'node:fs';
import path from 'node:path';

/** Files that make a folder a workspace root, with the package folders they list (null: every folder below). */
function members(dir: string): string[] | null | undefined {
  const pkg = readJson(path.join(dir, 'package.json')) as { workspaces?: string[] | { packages?: string[] } } | null;
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (ws && Array.isArray(ws.packages)) return ws.packages;
  const pnpm = read(path.join(dir, 'pnpm-workspace.yaml'));
  if (pnpm !== null) return yamlList(pnpm, 'packages');
  const lerna = readJson(path.join(dir, 'lerna.json')) as { packages?: string[] } | null;
  if (lerna) return Array.isArray(lerna.packages) ? lerna.packages : ['packages/*'];
  if (['nx.json', 'turbo.json', 'rush.json'].some((f) => fs.existsSync(path.join(dir, f)))) return null;
  return undefined;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  const text = read(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The items of a top-level list in a small YAML file ("packages:\n  - 'apps/*'"). */
function yamlList(text: string, key: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    if (new RegExp(`^${key}\\s*:`).test(line)) inList = true;
    else if (inList && /^\s*-\s*/.test(line)) out.push(line.replace(/^\s*-\s*/, '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, ''));
    else if (inList && /^\S/.test(line)) break;
  }
  return out;
}

/** A workspace's package pattern ("packages/*", "apps/**") → a test on a folder path relative to the workspace. */
function globRe(glob: string): RegExp {
  const body = glob
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split(/(\*\*\/?|\*)/)
    .map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/** Whether a package folder (relative to the workspace) is one the workspace lists. */
function isMember(rel: string, globs: string[]): boolean {
  const included = globs.filter((g) => !g.startsWith('!'));
  const excluded = globs.filter((g) => g.startsWith('!')).map((g) => globRe(g.slice(1)));
  return included.some((g) => globRe(g).test(rel)) && !excluded.some((re) => re.test(rel));
}

/**
 * The root of the workspace whose package `dir` is in (or `dir` itself when it is the root), or null when it is in
 * none. A package below a workspace root that the workspace doesn't list (a copy, a fixture) is in none.
 */
export function workspaceRoot(dir: string): string | null {
  const start = path.resolve(dir);
  // The package `dir` is in: its own folder, or the nearest one above with a package.json.
  let pkg: string | null = null;
  for (let cur = start; ; ) {
    pkg ??= fs.existsSync(path.join(cur, 'package.json')) ? cur : null;
    const globs = members(cur);
    if (globs !== undefined) {
      if (cur === start || cur === pkg) return cur;
      const rel = path.relative(cur, pkg ?? start).split(path.sep).join('/');
      return globs === null || isMember(rel, globs) ? cur : null;
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Whether `file` is inside `dir` (both absolute). */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function expand(dir: string, parts: string[]): string[] {
  if (!parts.length) return fs.existsSync(path.join(dir, 'package.json')) ? [dir] : [];
  const [head, ...rest] = parts;
  // Any folder below: two levels deep is plenty for packages.
  if (head === '**') return [...expand(dir, rest), ...subdirs(dir).flatMap((d) => [...expand(d, rest), ...subdirs(d).flatMap((e) => expand(e, rest))])];
  if (head.includes('*')) return subdirs(dir).filter((d) => globRe(head).test(path.basename(d))).flatMap((d) => expand(d, rest));
  return expand(path.join(dir, head), rest);
}

/** The package folders a workspace root lists (absolute). */
export function workspacePackages(root: string): string[] {
  const globs = members(root);
  if (!globs) return [];
  const found = new Set(globs.filter((g) => !g.startsWith('!')).flatMap((g) => expand(root, g.replace(/^\.\//, '').replace(/\/+$/, '').split('/'))));
  const excluded = globs.filter((g) => g.startsWith('!')).map((g) => globRe(g.slice(1)));
  return [...found].filter((d) => !excluded.some((re) => re.test(path.relative(root, d).split(path.sep).join('/'))));
}
