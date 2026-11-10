import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CodeIndex, type Coverage } from './code-index.ts';
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

/** How long one code search may take; past it, the answer says how many files it covered. */
const SEARCH_BUDGET_MS = 4000;
/** A git commit waits this long for hooks (lint, tests, signing) before it is called off. */
const COMMIT_TIMEOUT_MS = 60_000;
/** A repository or Playwright that isn't there is looked for again after this long. */
const RECHECK_MS = 5000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.devspace', '.saywright', '.next', '.nuxt', '.svelte-kit', '.astro', '.output', 'coverage', 'test-results', 'playwright-report', '.vite', '.turbo', '.vercel']);

/** Refuses a path (relative to the project or its workspace) in a folder that isn't the app's code, or an environment file. */
function offLimits(relative: string, asked: string): void {
  const parts = relative.split(path.sep);
  if (IGNORED_DIRS.has(parts[0]) || parts.some((p) => p === 'node_modules' || p === '.git')) throw new HttpError(400, `Path is not editable: ${asked}`);
  if (parts.some((p) => p.startsWith('.env'))) throw new HttpError(400, 'Environment files are off limits');
}
const TEXT_EXT = /\.([cm]?[jt]sx?|css|scss|sass|less|styl|json|md|mdx|html?|svg|vue|svelte|astro|php|erb|ejs|hbs|handlebars|mustache|njk|liquid|twig|jinja2?|j2|cshtml|razor|py|rb|go|ya?ml|toml|xml|txt)$/i;

/** Folders never searched: dependencies, builds, tools' caches and other dot folders (as listFiles walks them). */
const unsearched = (name: string) => IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.storybook');

/** A project file worth searching: text, outside the folders above. */
function searchable(rel: string): boolean {
  const parts = rel.split('/');
  return TEXT_EXT.test(parts[parts.length - 1]) && !parts.some(unsearched);
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
  resolve(rel: string): string {
    if (!this.hasCode) throw new HttpError(409, 'This app has no code on this computer. Link its folder to make changes.', 'no-code');
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
    fs.writeFileSync(tmp, content);
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
        } else if (TEXT_EXT.test(e.name)) {
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
        if (line.test(lineText)) {
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
   * Commit these files. Runs alongside the studio (hooks can take a while) and gives up after a minute; when it fails,
   * `error` says why, in git's own words.
   */
  async commit(files: string[], message: string): Promise<{ committed: boolean; error?: string }> {
    const git = (args: string[]) =>
      new Promise<void>((resolve, reject) =>
        execFile('git', args, { cwd: this.root, timeout: COMMIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
          if (!err) return resolve();
          const e = err as Error & { killed?: boolean; code?: unknown };
          const why = e.killed ? `git took more than ${COMMIT_TIMEOUT_MS / 1000} s (a commit hook may be waiting), so it was stopped` : String(stderr).trim().split('\n').filter(Boolean).slice(-3).join(' ') || e.message;
          reject(new Error(why));
        }),
      );
    try {
      await git(['add', '--', ...files]);
      await git(['commit', '-m', message, '--', ...files]);
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
    const dir = path.join(this.root, '.saywright');
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    return dir;
  }
}
