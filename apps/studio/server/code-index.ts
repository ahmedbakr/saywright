/**
 * The project's code as searches see it, shared by everything that looks through it: code search for the AI and AI
 * apps over MCP (Project.search), and anything else that reads the whole project (locating elements can move onto it).
 *
 * The list of files comes from git in a repository (the files it tracks, and new ones it doesn't ignore), else from a
 * walk that honours .gitignore. Files are read a few at a time, so the studio keeps answering meanwhile, and kept while
 * they are unchanged, so a burst of searches reads the project once. A scan has a time budget and says how much it
 * covered: a search that stops short says so, rather than answering as if it had looked everywhere.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { breathe } from './slices.ts';
import { decodeText } from './text-file.ts';

/** How much of the project a scan looked at. */
export interface Coverage {
  /** Files looked through. */
  searched: number;
  /** Files there were to look through. */
  total: number;
  /** Files skipped because they are too big to be code someone wrote (bundles, data). */
  tooLarge: number;
  /** The scan ran out of time before the end of the list. */
  timedOut: boolean;
}

interface ScanOptions {
  /** Stop after this long (ms); the coverage then says how far it got. */
  budgetMs?: number;
}

/** Above this size a file is generated or data, not code someone wrote. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LIST_TTL_MS = 3000;
/** A text read less than this long ago is used without looking at the file again. */
const CHECK_TTL_MS = 2000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** Texts nobody has looked at for this long are let go. */
const IDLE_MS = 60_000;
const READ_AHEAD = 8;

interface Cached {
  text: string | null;
  size: number;
  mtimeMs: number;
  checkedAt: number;
}

export class CodeIndex {
  private list: { at: number; files: Promise<string[]> } | null = null;
  private texts = new Map<string, Cached>();
  /** Reads under way: searches at the same time share them. */
  private reading = new Map<string, Promise<string | null>>();
  private bytes = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;

  /**
   * `root`: the project's folder. `wanted`: which project-relative paths are worth searching (the caller's rules:
   * text files, outside dependency and build folders). `skipFolder`: folders (by name) a walk never goes into.
   */
  constructor(
    private root: string,
    private wanted: (rel: string) => boolean,
    private skipFolder: (name: string) => boolean = () => false,
  ) {}

  /** Every file worth searching, relative to the root, in path order. The list is reused for a few seconds. */
  files(): Promise<string[]> {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.files;
    const files = this.listFiles().catch(() => [] as string[]);
    this.list = { at: Date.now(), files };
    return files;
  }

  /** A file's text, or null when it can't be read, is a link, is too large, or isn't text. */
  text(rel: string): Promise<string | null> {
    this.touch();
    const hit = this.texts.get(rel);
    if (hit && Date.now() - hit.checkedAt < CHECK_TTL_MS) return Promise.resolve(this.use(rel, hit));
    let p = this.reading.get(rel);
    if (!p) {
      p = this.load(rel, hit).finally(() => this.reading.delete(rel));
      this.reading.set(rel, p);
    }
    return p;
  }

  private async load(rel: string, hit: Cached | undefined): Promise<string | null> {
    const abs = path.join(this.root, rel);
    let stat: fs.Stats;
    try {
      // Links can lead outside the project: they are never read.
      stat = await fs.promises.lstat(abs);
    } catch {
      this.drop(rel);
      return null;
    }
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      hit.checkedAt = Date.now();
      return this.use(rel, hit);
    }
    let text: string | null = null;
    if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
      try {
        // As the studio reads any file of the project: UTF-8, or Latin-1 for a file that isn't; a binary one is no text.
        text = decodeText(await fs.promises.readFile(abs), rel).text;
      } catch {
        text = null;
      }
    }
    this.store(rel, { text, size: stat.size, mtimeMs: stat.mtimeMs, checkedAt: Date.now() });
    return text;
  }

  /** The studio changed or removed a file: read it afresh next time. */
  forget(rel: string): void {
    this.drop(rel.replace(/\\/g, '/').replace(/^\.\//, ''));
    this.list = null;
  }

  /**
   * Read `files` in order (a few ahead) and hand each text to `visit` until it returns true, the list ends or the
   * budget runs out. Files over MAX_FILE_BYTES are skipped and counted.
   */
  async scan(files: string[], visit: (rel: string, text: string) => boolean | void, opts: ScanOptions = {}): Promise<Coverage> {
    const started = Date.now();
    const coverage: Coverage = { searched: 0, total: files.length, tooLarge: 0, timedOut: false };
    const pending = new Map<number, Promise<string | null>>();
    const ahead = (i: number) => {
      for (let k = i; k < Math.min(files.length, i + READ_AHEAD); k++) if (!pending.has(k)) pending.set(k, this.text(files[k]));
    };
    for (let i = 0; i < files.length; i++) {
      if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs) {
        coverage.timedOut = true;
        break;
      }
      ahead(i);
      const text = await pending.get(i)!;
      pending.delete(i);
      if (text === null) {
        // Too large to be code someone wrote: counted, so the answer says so. Gone since the list was made, a link or
        // unreadable: not a file there was to search.
        if ((this.texts.get(files[i])?.size ?? 0) > MAX_FILE_BYTES) coverage.tooLarge++;
        else coverage.total--;
        continue;
      }
      coverage.searched++;
      if (visit(files[i], text)) break;
      await breathe();
    }
    return coverage;
  }

  private async listFiles(): Promise<string[]> {
    const tracked = await gitFiles(this.root);
    // Outside a repository, or in a folder the enclosing repository ignores: look at the folder itself.
    const all = tracked?.length ? tracked : await walk(this.root, this.skipFolder);
    return all.filter((f) => this.wanted(f)).sort();
  }

  private use(rel: string, c: Cached): string | null {
    // Most recently used last, so the oldest go first when the cache is full.
    this.texts.delete(rel);
    this.texts.set(rel, c);
    return c.text;
  }

  private store(rel: string, c: Cached): void {
    this.drop(rel);
    this.texts.set(rel, c);
    this.bytes += c.text?.length ?? 0;
    for (const [key, old] of this.texts) {
      if (this.bytes <= MAX_CACHE_BYTES) break;
      this.drop(key, old);
    }
  }

  private drop(rel: string, c = this.texts.get(rel)): void {
    if (!c) return;
    this.texts.delete(rel);
    this.bytes -= c.text?.length ?? 0;
  }

  /** While searches keep coming the texts stay; a minute after the last one they go. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.texts.clear();
      this.bytes = 0;
      this.list = null;
    }, IDLE_MS);
    this.idle.unref?.();
  }
}

/**
 * The files git knows in this folder (tracked, and new ones not ignored), or null when it isn't a repository. New
 * files are never looked for in node_modules, even where .gitignore forgot it.
 */
function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--exclude=node_modules'], { cwd: root, maxBuffer: 256 * 1024 * 1024, timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve([...new Set(stdout.split('\0').filter(Boolean))]);
    });
  });
}

/** Every file under `root` that its .gitignore files leave in, outside the folders `skip` names. */
async function walk(root: string, skip: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, rules: IgnoreRule[]) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    const own = entries.some((e) => e.name === '.gitignore' && e.isFile()) ? await readIgnore(root, dir) : [];
    const all = own.length ? [...rules, ...own] : rules;
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.name === '.git' || e.isSymbolicLink() || (e.isDirectory() && skip(e.name))) continue;
      if (ignored(all, rel, e.isDirectory())) continue;
      if (e.isDirectory()) await visit(rel, all);
      else if (e.isFile()) out.push(rel);
    }
  };
  await visit('', []);
  return out;
}

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** A .gitignore's patterns, as rules on paths relative to the root. */
async function readIgnore(root: string, dir: string): Promise<IgnoreRule[]> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(root, dir, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    // A pattern with a slash (other than at the end) is relative to its .gitignore's folder; one without matches at any depth.
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    const base = dir ? `${escapeRe(dir)}/` : '';
    rules.push({ re: new RegExp(`^${base}${anchored ? '' : '(?:.*/)?'}${globToRe(line)}$`), negate, dirOnly });
  }
  return rules;
}

function ignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let out = false;
  for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(rel)) out = !r.negate;
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function globToRe(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" any folders (or none), "/**" everything inside.
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) re += escapeRe(glob[++i]);
    else re += escapeRe(c);
  }
  return re;
}
