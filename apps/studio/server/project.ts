import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CodeIndex, type Coverage } from './code-index.ts';
import { writeBeside } from './fsx.ts';
import { HttpError } from './http.ts';
import { workspaceRoot } from '../../../packages/vite/src/workspace.ts';
import { importedFrom, variantsIn } from './quick/variants.ts';
import { NotTextError, decodeText, type TextEncoding } from './text-file.ts';

export interface ComponentProp {
  values: string[];
  default?: string;
  /** Values have a natural order (sm < md < lg), so "bigger"/"smaller" can step through them. */
  ordered?: boolean;
  /** The values "bigger"/"smaller" step through, smallest first, when not all of them (an "icon" size isn't a step). */
  ladder?: string[];
  /** How the value is written: `boolean` as `prop` / `prop={false}`, `number` as `prop={2}`; a string otherwise. */
  type?: 'boolean' | 'number';
}

export interface ComponentSpec {
  file?: string;
  /** Which prop holds the visible text: "children" or a prop name like "label". */
  text?: string;
  props: Record<string, ComponentProp>;
}

interface ProjectConfig {
  name?: string;
  components: Record<string, ComponentSpec>;
  synonyms: Record<string, string[]>;
  guidelines?: string;
}

/** What people call the variants most design systems have (shadcn/ui's among them), for projects that don't say. */
const DEFAULT_SYNONYMS: Record<string, string[]> = {
  red: ['danger', 'destructive', 'error'],
  danger: ['destructive', 'error'],
  delete: ['destructive', 'danger'],
  green: ['success', 'primary', 'brand'],
  outline: ['outline', 'outlined', 'secondary'],
  outlined: ['outline', 'secondary'],
  bordered: ['outline'],
  subtle: ['ghost', 'muted', 'secondary'],
  quiet: ['ghost', 'muted'],
  plain: ['ghost', 'link', 'default'],
  link: ['link'],
  primary: ['primary', 'default'],
  main: ['primary', 'default'],
  normal: ['default', 'regular', 'md'],
  grey: ['secondary', 'muted'],
  gray: ['secondary', 'muted'],
};

const EMPTY_CONFIG: ProjectConfig = { components: {}, synonyms: DEFAULT_SYNONYMS };

interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** The longest line a pattern is tried on: minified code is cut to this. */
const MAX_MATCH_LINE = 2000;

/**
 * Whether a regular expression may take exponential time: a quantified group whose body is itself quantified or has
 * alternatives (`(a+)+`, `(a|aa)*`, `(\\w+\\s?)*`), or a backreference. Conservative: some safe patterns are refused too.
 */
export function unsafePattern(source: string): boolean {
  if (/\\[1-9]|\\k</.test(source)) return true;
  const stack: { quantified: boolean; alt: boolean }[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      continue;
    }
    const top = stack.at(-1);
    if (c === '(') stack.push({ quantified: false, alt: false });
    else if (c === '|' && top) top.alt = true;
    else if (c === ')') {
      const g = stack.pop();
      const next = source[i + 1];
      const quantified = next === '*' || next === '+' || (next === '{' && /^\{\d*,?\d*\}/.test(source.slice(i + 1)) && !/^\{(0|1)\}/.test(source.slice(i + 1)));
      if (quantified && g && (g.quantified || g.alt)) return true;
      if (stack.length && g && (g.quantified || quantified)) stack.at(-1)!.quantified = true;
    } else if ((c === '*' || c === '+' || c === '{') && top) top.quantified = true;
  }
  return false;
}

/** How long one code search may take; past it, the answer says how many files it covered. */
const SEARCH_BUDGET_MS = 4000;
/** A git commit waits this long for hooks (lint, tests, signing) before it is called off. */
const COMMIT_TIMEOUT_MS = 60_000;
/** A repository or Playwright that isn't there is looked for again after this long. */
const RECHECK_MS = 5000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.devspace', '.saywright', '.next', '.nuxt', '.svelte-kit', '.astro', '.output', 'coverage', 'test-results', 'playwright-report', '.vite', '.turbo', '.vercel']);

/**
 * Files that hold keys or credentials, by name (compared without case: on macOS and Windows ".ENV" opens ".env"):
 * environment files, package managers' and tools' credentials, private keys and certificates, keystores, and the
 * folders tools keep them in. Never read, searched, listed, sent to a model or changed by one.
 */
const SECRET_FILE = /^(\.env.*|\.dev\.vars.*|\.npmrc|\.yarnrc\.yml|\.netrc|_netrc|\.pypirc|\.htpasswd|.*\.(pem|key|p12|pfx|keystore|jks|kdbx)|id_(rsa|dsa|ed25519|ecdsa).*|.*credentials.*|secrets\..*|\.git-credentials)$/i;
const SECRET_DIR = /^\.(aws|ssh|gnupg|docker|kube|azure|gcloud|config\/gcloud)$/i;
export const isSecretPath = (relative: string): boolean => {
  const parts = relative.split(/[\\/]/);
  return parts.slice(0, -1).some((p) => SECRET_DIR.test(p)) || SECRET_DIR.test(parts.at(-1) ?? '') || SECRET_FILE.test(parts.at(-1) ?? '');
};

/** Refuses a path (relative to the project or its workspace) in a folder that isn't the app's code, or a file that holds secrets. */
function offLimits(relative: string, asked: string): void {
  const parts = relative.split(path.sep).map((p) => p.toLowerCase());
  if (IGNORED_DIRS.has(parts[0]) || parts.some((p) => p === 'node_modules' || p === '.git')) throw new HttpError(400, `Path is not editable: ${asked}`);
  if (parts.some((p) => p.startsWith('.env'))) throw new HttpError(400, 'Environment files are off limits');
  if (isSecretPath(relative)) throw new HttpError(400, `Files that hold keys or credentials are off limits: ${asked}`);
}
const TEXT_EXT = /\.([cm]?[jt]sx?|css|scss|sass|less|styl|json|md|mdx|html?|svg|vue|svelte|astro|php|erb|ejs|hbs|handlebars|mustache|njk|liquid|twig|jinja2?|j2|cshtml|razor|py|rb|go|ya?ml|toml|xml|txt)$/i;

/** Folders never searched: dependencies, builds, tools' caches and other dot folders (as listFiles walks them). */
const unsearched = (name: string) => IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.storybook');

/** A project file worth searching: text, outside the folders above. */
function searchable(rel: string): boolean {
  const parts = rel.split('/');
  return TEXT_EXT.test(parts[parts.length - 1]) && !parts.some(unsearched) && !isSecretPath(rel);
}

export class Project {
  private cachedConfig: { mtime: number; config: ProjectConfig } | null = null;
  /** Where the studio shows the app when its proxy is in front of it: the app's pages name their code at this address. */
  frame?: string;

  /**
   * `root`: the app's code. An app linked by URL alone has none: `hasCode` is false, `root` is its data
   * folder, and nothing in it is read or written as code.
   */
  constructor(
    public readonly root: string,
    public url: string,
    private readonly dataDir?: string,
    public readonly hasCode = true,
  ) {}

  get name(): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'));
      if (this.config.name) return this.config.name;
      if (typeof pkg.name === 'string') return pkg.name;
    } catch {
      /* fall through */
    }
    return path.basename(this.root);
  }

  get configPath(): string {
    return path.join(this.root, 'saywright.config.json');
  }

  get hasConfig(): boolean {
    return fs.existsSync(this.configPath);
  }

  get config(): ProjectConfig {
    try {
      const stat = fs.statSync(this.configPath);
      if (this.cachedConfig && this.cachedConfig.mtime === stat.mtimeMs) return this.cachedConfig.config;
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      const config: ProjectConfig = {
        name: typeof raw.name === 'string' ? raw.name : undefined,
        components: raw.components && typeof raw.components === 'object' ? raw.components : {},
        synonyms: { ...DEFAULT_SYNONYMS, ...(raw.synonyms && typeof raw.synonyms === 'object' ? raw.synonyms : {}) },
        guidelines: typeof raw.guidelines === 'string' ? raw.guidelines : undefined,
      };
      this.cachedConfig = { mtime: stat.mtimeMs, config };
      return config;
    } catch {
      return EMPTY_CONFIG;
    }
  }

  private detected = new Map<string, { mtime: number; spec: ComponentSpec | null }>();

  /**
   * How a component used in `fromFile` is styled: from saywright.config.json, or else read from the cva(...)
   * variants in the file it is imported from (shadcn/ui and other class-variance-authority components).
   */
  componentSpec(name: string, fromFile: string): ComponentSpec | undefined {
    const configured = this.config.components[name];
    if (configured) return configured;
    if (!/^[A-Z]/.test(name)) return undefined;
    try {
      const file = importedFrom(this.root, fromFile, this.read(fromFile), name);
      if (!file) return undefined;
      const mtime = fs.statSync(this.resolve(file)).mtimeMs;
      const key = `${file}\n${name}`;
      const hit = this.detected.get(key);
      if (hit && hit.mtime === mtime) return hit.spec ?? undefined;
      const spec = variantsIn(this.read(file), name);
      if (spec) spec.file = file;
      this.detected.set(key, { mtime, spec });
      return spec ?? undefined;
    } catch {
      return undefined;
    }
  }

  private ws: string | null | undefined;

  /** The workspace (monorepo) the app is part of: its sibling packages are the app's code too. */
  private get workspace(): string | null {
    if (this.ws === undefined) this.ws = workspaceRoot(this.root);
    return this.ws;
  }

  /** `abs` relative to the project, or for a sibling package's file to the workspace the app is part of; null outside both. */
  private inside(abs: string): string | null {
    const own = path.relative(this.root, abs);
    if (own && !own.startsWith('..') && !path.isAbsolute(own)) return own;
    const ws = this.workspace ? path.relative(this.workspace, abs) : '';
    return ws && !ws.startsWith('..') && !path.isAbsolute(ws) ? ws : null;
  }

  /** Resolve a project-relative path ("../packages/ui/Button.tsx" for a workspace's package), refusing anything outside or in ignored folders. */
  /**
   * The app's folder is where it was. Renamed or deleted while the studio runs, it is never made again by a write
   * (an empty folder in its place would stop it being moved back or cloned there): every request says so instead.
   */
  checkRoot(): void {
    if (this.hasCode && !fs.existsSync(this.root)) throw new HttpError(409, `The app’s folder isn’t there any more (${this.root}): put it back, or link the app again.`, 'app-gone');
  }

  resolve(rel: string): string {
    if (!this.hasCode) throw new HttpError(409, 'This app has no code on this computer. Link its folder to make changes.', 'no-code');
    this.checkRoot();
    if (typeof rel !== 'string' || !rel.trim()) throw new HttpError(400, 'Empty path');
    const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    const abs = path.resolve(this.root, clean);
    const relative = this.inside(abs);
    if (!relative) throw new HttpError(400, `Path is outside the project: ${rel}`);
    offLimits(relative, rel);
    // Where a link inside the project leads must be inside it too (a repository can carry a link to ~/.ssh), and
    // not where the path itself may not go: a link to .env, .git or the studio's data is refused like them.
    const real = this.realTarget(abs);
    if (!real) throw new HttpError(400, `Path is outside the project: ${rel}`);
    offLimits(real, rel);
    return abs;
  }

  private realRoot: string | null = null;

  /**
   * Where a path leads with every link along it followed, relative to the project (or its workspace); null when that
   * is outside both. A file that doesn't exist yet is judged by the folder it would be written in; a link that leads
   * nowhere is refused (writing would create its target).
   */
  private realTarget(abs: string): string | null {
    this.realRoot ??= fs.realpathSync(this.root);
    let probe = abs;
    const rest: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) return null;
        rest.unshift(path.basename(probe));
        probe = parent;
      }
    }
    let real: string;
    try {
      real = fs.realpathSync(probe);
    } catch {
      return null;
    }
    const target = path.join(real, ...rest);
    for (const root of [this.realRoot, this.workspace && fs.realpathSync(this.workspace)]) {
      const relative = root ? path.relative(root, target) : '';
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    }
    return null;
  }

  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  exists(rel: string): boolean {
    try {
      return fs.statSync(this.resolve(rel)).isFile();
    } catch {
      return false;
    }
  }

  /** A file's bytes, as they are on disk. */
  readBytes(rel: string): Buffer {
    const abs = this.resolve(rel);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat) throw new HttpError(404, `No such file: ${rel}`);
    if (stat.isDirectory()) throw new HttpError(400, `${rel} is a folder, not a file`, 'folder');
    return fs.readFileSync(abs);
  }

  /**
   * A file as text, with the encoding that writes the same bytes back (UTF-8, or Latin-1 for a file that isn't: see
   * text-file.ts). A binary file is refused: it is no text to show or to edit.
   */
  readText(rel: string): { text: string; encoding: TextEncoding } {
    const bytes = this.readBytes(rel);
    try {
      return decodeText(bytes, rel);
    } catch (err) {
      throw err instanceof NotTextError ? new HttpError(400, err.message, 'not-text') : err;
    }
  }

  read(rel: string): string {
    return this.readText(rel).text;
  }

  /** Atomic write: temp file + rename, so the dev server never sees half a file. Text is written as UTF-8; bytes as they are. */
  write(rel: string, content: string | Uint8Array): void {
    const asked = this.resolve(rel);
    // Through a link, to the file it leads to (resolve checked it): renaming over the link would make it a copy.
    let abs = asked;
    try {
      if (fs.lstatSync(asked).isSymbolicLink()) abs = fs.realpathSync(asked);
    } catch {
      /* a new file */
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.saywright-tmp`;
    writeBeside(tmp, abs, content);
    fs.renameSync(tmp, abs);
    this.index?.forget(this.rel(asked));
    if (abs !== asked) this.index?.forget(this.rel(abs));
  }

  remove(rel: string): void {
    const abs = this.resolve(rel);
    fs.rmSync(abs, { force: true });
    this.index?.forget(this.rel(abs));
  }

  private index: CodeIndex | null = null;

  /** The project's files as searches see them (see CodeIndex), shared by every search of this project. */
  get code(): CodeIndex {
    this.index ??= new CodeIndex(this.root, searchable, unsearched);
    return this.index;
  }

  /**
   * The workspace's other packages (a monorepo's), as searches see them: the app's own folder left out, paths as the
   * app reads them ("../../packages/ui/Button.tsx"). Null for an app on its own.
   */
  private get siblings(): { index: CodeIndex; path: (rel: string) => string } | null {
    if (this.siblingIndex === undefined) {
      const ws = this.workspace;
      const own = ws ? path.relative(ws, this.root).split(path.sep).join('/') : '';
      this.siblingIndex =
        ws && own && !own.startsWith('..')
          ? { index: new CodeIndex(ws, (rel) => rel !== own && !rel.startsWith(`${own}/`) && searchable(rel), unsearched), path: (rel) => this.rel(path.join(ws, rel)) }
          : null;
    }
    return this.siblingIndex;
  }

  private siblingIndex: { index: CodeIndex; path: (rel: string) => string } | null | undefined;

  listFiles(dir = '', limit = 500): string[] {
    const out: string[] = [];
    if (!this.hasCode) return out;
    const start = dir ? this.resolve(dir) : this.root;
    const own = path.resolve(this.root);
    const walk = (abs: string) => {
      if (out.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= limit) return;
        // Links can lead outside the project: they are never listed (nor searched).
        if ((e.name.startsWith('.') && e.name !== '.storybook') || e.isSymbolicLink()) continue;
        const child = path.join(abs, e.name);
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name) && path.resolve(child) !== own) walk(child);
        } else if (TEXT_EXT.test(e.name) && !isSecretPath(e.name)) {
          out.push(this.rel(child));
        }
      }
    };
    walk(start);
    // The app's own files first, then (in a monorepo) the workspace's other packages, which it reads too.
    if (!dir && this.workspace && this.siblings) walk(this.workspace);
    return out;
  }

  /**
   * Lines matching `query` (text, or a regular expression), case-insensitive, in every file worth searching (see
   * CodeIndex) or those under `dir`. Stops at `limit` hits, or when its time is up: the coverage says how much it saw.
   */
  async search(query: string, opts: { regex?: boolean; dir?: string; limit?: number; budgetMs?: number } = {}): Promise<{ hits: SearchHit[] } & Coverage> {
    const limit = opts.limit ?? 60;
    if (!this.hasCode) return { hits: [], searched: 0, total: 0, tooLarge: 0, timedOut: false };
    let source: string;
    try {
      source = opts.regex ? new RegExp(query).source : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } catch {
      throw new HttpError(400, 'Invalid search pattern');
    }
    // The match runs on the studio's only thread: a pattern that can take exponential time would freeze everything,
    // Stop included. A repeated group that itself repeats or alternates, or a backreference, is refused.
    if (opts.regex && unsafePattern(query)) throw new HttpError(400, 'That search pattern could take too long (a repeated group that repeats inside, or a backreference). Search for plain text, or a simpler pattern.');
    const line = new RegExp(source, 'i');
    // Over a whole file: where a line may match (^ and $ at each line), so only those lines are tested.
    const any = new RegExp(source, 'gim');
    const folder = (opts.dir ?? '').replace(/^\.?\/?$/, '');
    const dir = folder ? `${this.rel(this.resolve(folder))}/` : '';
    const worth = (f: string) => f.startsWith(dir) && (!/\.(svg|json)$/i.test(f) || /package\.json$|saywright\.config\.json$/.test(f));
    const hits: SearchHit[] = [];
    const started = Date.now();
    const budgetMs = opts.budgetMs ?? SEARCH_BUDGET_MS;
    const coverage = await this.code.scan((await this.code.files()).filter(worth), this.matcher(any, line, hits, limit, (f) => f), { budgetMs });
    // In a monorepo, the workspace's other packages too: the app's code reaches them.
    const sib = this.siblings;
    if (sib && hits.length < limit && !coverage.timedOut && (!dir || dir.startsWith('../'))) {
      const wanted = (await sib.index.files()).filter((f) => worth(sib.path(f)));
      const more = await sib.index.scan(wanted, this.matcher(any, line, hits, limit, sib.path), { budgetMs: Math.max(200, budgetMs - (Date.now() - started)) });
      return { hits, searched: coverage.searched + more.searched, total: coverage.total + more.total, tooLarge: coverage.tooLarge + more.tooLarge, timedOut: more.timedOut };
    }
    return { hits, ...coverage };
  }

  /** What a search does with a file's text: the lines that match, as hits (`at`: the path the app reads it by). */
  private matcher(any: RegExp, line: RegExp, hits: SearchHit[], limit: number, at: (file: string) => string): (file: string, text: string) => boolean {
    return (file, text) => {
      any.lastIndex = 0;
      let lineNo = 1;
      let counted = 0;
      for (let m = any.exec(text); m; m = any.exec(text)) {
        const start = m.index === 0 ? 0 : text.lastIndexOf('\n', m.index - 1) + 1;
        const end = text.indexOf('\n', m.index);
        const stop = end === -1 ? text.length : end;
        for (let i = text.indexOf('\n', counted); i !== -1 && i < start; i = text.indexOf('\n', i + 1)) lineNo++;
        counted = start;
        const lineText = text.slice(start, stop);
        // A very long line (minified code, data) is never matched as a whole: its first part is.
        if (line.test(lineText.length > MAX_MATCH_LINE ? lineText.slice(0, MAX_MATCH_LINE) : lineText)) {
          hits.push({ path: at(file), line: lineNo, text: lineText.trim().slice(0, 200) });
          if (hits.length >= limit) return true;
        }
        if (end === -1) break;
        any.lastIndex = end + 1;
      }
      return false;
    };
  }

  private gitRoot: { found: boolean; at: number } | null = null;

  /**
   * Whether the code is in a git repository: a .git (folder, or file for worktrees) here or above. Once found it stays
   * found; otherwise it is looked for again after a few seconds (git init can come while the studio runs).
   */
  get isGit(): boolean {
    if (!this.hasCode) return false;
    if (this.gitRoot && (this.gitRoot.found || Date.now() - this.gitRoot.at < RECHECK_MS)) return this.gitRoot.found;
    let found = false;
    for (let dir = path.resolve(this.root); ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        found = true;
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    this.gitRoot = { found, at: Date.now() };
    return found;
  }

  /**
   * Commit exactly what a change wrote to these files, and nothing of the person's own. Each file must be, in git,
   * what it was before the change (`before`, null for a file the change created), with nothing of theirs staged, and on
   * disk what the change left (`after`): otherwise their own uncommitted work would go into the commit, and nothing is
   * committed (`note` says why). Nor is anything committed into a repository that doesn't track the app's folder (a
   * home folder kept in git, above it). When git refuses (a hook, no identity), what was staged for the commit is
   * unstaged again and `error` says why, in git's own words. Runs alongside the studio and gives up after a minute.
   */
  async commit(files: { path: string; before: Buffer | null; after: Buffer }[], message: string): Promise<{ committed: boolean; error?: string; note?: string }> {
    const git = (args: string[], input?: Buffer) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile('git', args, { cwd: this.root, timeout: COMMIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const e = err as Error & { killed?: boolean; code?: unknown };
          const why = e.killed ? `git took more than ${COMMIT_TIMEOUT_MS / 1000} s (a commit hook may be waiting), so it was stopped` : String(stderr).trim().split('\n').filter(Boolean).slice(-3).join(' ') || e.message;
          reject(Object.assign(new Error(why), { exit: e.code }));
        });
        if (input) child.stdin?.end(input);
      });
    const quiet = (args: string[], input?: Buffer) => git(args, input).then((out) => out.trim(), () => null);
    const not = (why: string) => ({ committed: false, note: `Kept, not committed: ${why}` });
    try {
      const top = await quiet(['rev-parse', '--show-toplevel']);
      if (top === null) return { committed: false };
      const own = path.resolve(fs.realpathSync(top)) === path.resolve(fs.realpathSync(this.root));
      if (!own && !(await quiet(['log', '-1', '--format=%H', '--', '.']))) return not(`the git repository at ${top} doesn’t track this app’s folder.`);
      const hasHead = (await quiet(['rev-parse', '-q', '--verify', 'HEAD'])) !== null;
      for (const f of files) {
        const theirs = not(`${f.path} also has changes of yours that aren’t committed.`);
        // In git (HEAD), the file as the change found it; its bytes as git would store them (line ends, filters).
        const committed = hasHead ? await quiet(['rev-parse', '-q', '--verify', `HEAD:./${f.path}`]) : null;
        const found = f.before === null ? null : await quiet(['hash-object', `--path=${f.path}`, '--stdin'], f.before);
        if (committed !== found) return theirs;
        // Nothing of theirs staged for it, and on disk what the change left.
        const staged = hasHead ? await quiet(['diff', '--cached', '--name-only', '--', f.path]) : await quiet(['ls-files', '--', f.path]);
        if (staged) return theirs;
        let now: Buffer | null = null;
        try {
          now = this.readBytes(f.path);
        } catch {
          /* gone */
        }
        if (!now || !now.equals(f.after)) return theirs;
      }
      const paths = files.map((f) => f.path);
      await git(['add', '--', ...paths]);
      try {
        await git(['commit', '-m', message, '--', ...paths]);
      } catch (err) {
        // Unstaged again: the index is as the person left it (these files had nothing of theirs staged).
        await (hasHead ? quiet(['reset', '-q', '--', ...paths]) : quiet(['rm', '-q', '--cached', '--', ...paths]));
        throw err;
      }
      return { committed: true };
    } catch (err) {
      return { committed: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private playwright: { found: boolean; at: number } | null = null;

  /** Whether @playwright/test is installed here or in a folder above. Once found it stays found; otherwise looked up again after a few seconds. */
  get hasPlaywright(): boolean {
    if (this.playwright && (this.playwright.found || Date.now() - this.playwright.at < RECHECK_MS)) return this.playwright.found;
    let found = false;
    let dir = this.root;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'node_modules', '@playwright', 'test', 'package.json'))) {
        found = true;
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    this.playwright = { found, at: Date.now() };
    return found;
  }

  /** Where the studio keeps this app's own data: sessions, metrics, settings. */
  stateDir(): string {
    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      return this.dataDir;
    }
    this.checkRoot();
    const dir = path.join(this.root, '.saywright');
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    return dir;
  }
}
