/**
 * From where code runs back to where it was written. Next.js, webpack and
 * Turbopack report positions in generated bundles ("chunks/ssr/…js:102:284");
 * this follows their source maps (on disk or from the app's dev server) to
 * "src/app/page.tsx:23:13". Handles plain and sectioned (index) maps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isInside, workspaceRoot } from '../../../../packages/vite/src/workspace.ts';
import { inProject } from '../locate.ts';
import type { Project } from '../project.ts';

/** The most a bundle or its map may weigh to be read: a development build's largest chunks, with room to spare. */
const MAX_BYTES = 96 * 1024 * 1024;
/** This computer, however it is named in an address. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

interface Section {
  line: number;
  column: number;
  map: Decoded;
}

interface Decoded {
  sources: string[];
  /** Per generated line: segments [genCol, sourceIndex, sourceLine, sourceCol], sorted by genCol. */
  lines: number[][][] | null;
  sections: Section[] | null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]));

function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineText of mappings.split(';')) {
    const segs: number[][] = [];
    let genCol = 0;
    if (lineText) {
      for (const segText of lineText.split(',')) {
        if (!segText) continue;
        const vals: number[] = [];
        let value = 0;
        let shift = 0;
        for (const ch of segText) {
          const digit = B64_INDEX.get(ch);
          if (digit === undefined) break;
          value += (digit & 31) << shift;
          if (digit & 32) shift += 5;
          else {
            vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
            value = 0;
            shift = 0;
          }
        }
        genCol += vals[0] ?? 0;
        if (vals.length >= 4) {
          srcIdx += vals[1];
          srcLine += vals[2];
          srcCol += vals[3];
          segs.push([genCol, srcIdx, srcLine, srcCol]);
        }
      }
    }
    lines.push(segs);
  }
  return lines;
}

function parseMap(raw: unknown): Decoded | null {
  const m = raw as { sections?: { offset: { line: number; column: number }; map: unknown }[]; sources?: string[]; sourceRoot?: string; mappings?: string };
  if (!m || typeof m !== 'object') return null;
  if (Array.isArray(m.sections)) {
    const sections = m.sections.map((s) => ({ line: s.offset.line, column: s.offset.column, map: parseMap(s.map) })).filter((s): s is Section => !!s.map);
    return { sources: [], lines: null, sections };
  }
  if (!Array.isArray(m.sources) || typeof m.mappings !== 'string') return null;
  const root = m.sourceRoot ? m.sourceRoot.replace(/\/?$/, '/') : '';
  return { sources: m.sources.map((s) => (root && !/^[a-z]+:/.test(s) ? root + s : s)), lines: decodeMappings(m.mappings), sections: null };
}

/** Generated (0-based line, 0-based column) → original source, 1-based line and column. */
function lookup(map: Decoded, line: number, column: number): { source: string; line: number; column: number } | null {
  if (map.sections) {
    let found: Section | null = null;
    for (const s of map.sections) if (s.line < line || (s.line === line && s.column <= column)) found = s;
    if (!found) return null;
    return lookup(found.map, line - found.line, line === found.line ? column - found.column : column);
  }
  const segs = map.lines?.[line];
  if (!segs?.length) return null;
  let best: number[] | null = null;
  for (const seg of segs) {
    if (seg[0] <= column) best = seg;
    else break;
  }
  best ??= segs[0];
  const source = map.sources[best[1]];
  return source ? { source, line: best[2] + 1, column: best[3] + 1 } : null;
}

/** "turbopack:///[project]/src/app/page.tsx", "webpack://_N_E/./src/x.tsx", "file:///abs/x.tsx", "../src/x.tsx" → a path. */
function cleanSource(source: string, mapDir: string | null): string {
  let s = source
    .replace(/^turbopack:\/\/\/(\[project\]\/)?/, '')
    .replace(/^webpack:\/\/[^/]*\/(\.\/)?/, '')
    .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?(\.\/)?/, '')
    .replace(/^file:\/\//, '')
    .replace(/\?.*$/, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as is */
  }
  if (!path.isAbsolute(s) && mapDir && /^\.\.?\//.test(s)) s = path.resolve(mapDir, s);
  return s;
}

export class SourceMapper {
  private maps = new Map<string, Promise<{ map: Decoded; dir: string | null } | null>>();

  constructor(private project: Project) {}

  /**
   * Whether an address is the app's own: where it runs, or the studio's proxy in front of it. The positions this
   * class is given come from the page (an element's source, an error's stack), and a page can write anything
   * there: no other address is ever asked for, so an app or site shown in the studio can't make the studio call
   * other servers on this computer or its network.
   */
  private own(address: string): boolean {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const port = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : '80');
    return [this.project.url, this.project.frame].some((mine) => {
      if (!mine) return false;
      try {
        const m = new URL(mine);
        return m.protocol === url.protocol && port(m) === port(url) && (m.hostname === url.hostname || (LOOPBACK.has(m.hostname) && LOOPBACK.has(url.hostname)));
      } catch {
        return false;
      }
    });
  }

  /** Whether a file is the app's to read: in its folder or its workspace's (never elsewhere on the disk, by any link). */
  private mine(file: string): boolean {
    if (!this.project.hasCode) return false;
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    };
    const at = real(file);
    if (!at) return false;
    const roots = [this.project.root, workspaceRoot(this.project.root)].map((r) => (r ? real(r) : null));
    if (!roots.some((r) => r && isInside(r, at))) return false;
    try {
      const stat = fs.statSync(at);
      return stat.isFile() && stat.size <= MAX_BYTES;
    } catch {
      return false;
    }
  }

  private async loadText(where: string): Promise<string | null> {
    if (/^https?:\/\//.test(where)) {
      if (!this.own(where)) return null;
      try {
        // A dev server doesn't send its own code elsewhere: a redirect isn't followed (it could lead anywhere).
        const res = await fetch(where, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
        if (!res.ok || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES || !res.body) return null;
        const parts: Buffer[] = [];
        let size = 0;
        for await (const chunk of res.body) {
          size += chunk.byteLength;
          if (size > MAX_BYTES) return null;
          parts.push(Buffer.from(chunk));
        }
        return Buffer.concat(parts).toString('utf8');
      } catch {
        return null;
      }
    }
    if (!this.mine(where)) return null;
    try {
      return fs.readFileSync(where, 'utf8');
    } catch {
      return null;
    }
  }

  private load(generated: string): Promise<{ map: Decoded; dir: string | null } | null> {
    let p = this.maps.get(generated);
    if (!p) {
      p = (async () => {
        const isUrl = /^https?:\/\//.test(generated);
        // A map next to the file, else the one the file names.
        let text = isUrl ? null : await this.loadText(`${generated}.map`);
        let dir: string | null = isUrl ? null : path.dirname(generated);
        if (!text) {
          const code = await this.loadText(generated);
          // The last reference in the file (Vite inlines the whole map there, so it can start far from the end).
          const at = code ? Math.max(code.lastIndexOf('//# sourceMappingURL='), code.lastIndexOf('//@ sourceMappingURL=')) : -1;
          const ref = at >= 0 ? /^\/\/[#@] sourceMappingURL=(\S+)/.exec(code!.slice(at))?.[1] : undefined;
          if (!ref) return null;
          if (ref.startsWith('data:')) {
            const comma = ref.indexOf(',');
            text = /;base64,/.test(ref.slice(0, comma + 1)) ? Buffer.from(ref.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(ref.slice(comma + 1));
          } else {
            const where = isUrl ? new URL(ref, generated).href : path.resolve(path.dirname(generated), decodeURIComponent(ref));
            text = await this.loadText(where);
            dir = isUrl ? null : path.dirname(where);
          }
        }
        if (!text) return null;
        try {
          const map = parseMap(JSON.parse(text));
          return map ? { map, dir } : null;
        } catch {
          return null;
        }
      })();
      this.maps.set(generated, p);
    }
    return p;
  }

  /** "where:line:col" in generated code → "src/file.tsx:line:col" in the project, or null when it can't be traced. */
  async map(src: string): Promise<string | null> {
    const m = /^(.*?):(\d+):(\d+)$/.exec(src);
    if (!m) return null;
    let where = m[1];
    if (where.startsWith('file://')) where = decodeURIComponent(where.slice(7));
    // Bundlers add cache-busting queries to file paths ("chunk._.js?7").
    if (!/^https?:\/\//.test(where)) where = where.replace(/\?[^/]*$/, '');
    // Relative paths from the browser are relative to the project (Vite serves files at their path).
    if (!/^https?:\/\//.test(where) && !path.isAbsolute(where)) where = path.join(this.project.root, where);
    if (/^https?:\/\//.test(where) ? this.own(where) : this.mine(where)) {
      // Already source? Then only make it relative.
      if (!/^https?:/.test(where) && /\.(tsx?|jsx|mjs|vue|svelte|astro|html?)$/.test(where) && !where.includes(`${path.sep}.next${path.sep}`)) return this.relative(where, Number(m[2]), Number(m[3]));
      const loaded = await this.load(where);
      if (!loaded) return null;
      const hit = lookup(loaded.map, Number(m[2]) - 1, Number(m[3]) - 1);
      if (!hit) return null;
      let source = cleanSource(hit.source, loaded.dir);
      // A map fetched from a dev server names files relative to the module's address (Vite: "App.tsx" for /src/App.tsx,
      // and /@fs/… for a file outside the app's folder, such as a sibling package of a workspace).
      if (/^https?:\/\//.test(where) && !path.isAbsolute(source) && !/^[a-z][\w+.-]*:/i.test(source)) {
        const at = decodeURIComponent(new URL(source, where).pathname);
        source = at.startsWith('/@fs/') ? at.slice(4) : at.replace(/^\/+/, '');
      }
      return this.relative(source, hit.line, hit.column);
    }
    return null;
  }

  /** Where each of webpack's eval'd modules is, by the name its code carries: in the chunks a dev build writes (Next.js, in .next). */
  private evalChunks: { at: number; files: Map<string, string> } | null = null;
  private evalMaps = new Map<string, Promise<Decoded | null>>();

  private async indexEvalChunks(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== 'cache' && e.name !== 'node_modules') await walk(abs);
        else if (e.isFile() && e.name.endsWith('.js')) {
          const text = await fs.promises.readFile(abs, 'utf8').catch(() => '');
          for (const m of text.matchAll(/sourceURL=(webpack-internal:\/\/\/[^\s"'\\]+)/g)) files.set(m[1], abs);
        }
      }
    };
    await walk(path.join(this.project.root, '.next'));
    return files;
  }

  private async evalMap(url: string): Promise<Decoded | null> {
    if (!this.evalChunks || (!this.evalChunks.files.has(url) && Date.now() - this.evalChunks.at > 5000)) this.evalChunks = { at: Date.now(), files: await this.indexEvalChunks() };
    const file = this.evalChunks.files.get(url);
    if (!file) return null;
    const key = `${file}\n${url}`;
    let map = this.evalMaps.get(key);
    if (!map) {
      map = fs.promises.readFile(file, 'utf8').then(
        (text) => {
          // The module's own map is the last one before its name, in the same eval'd string.
          const named = text.indexOf(`sourceURL=${url}`);
          const at = text.lastIndexOf('sourceMappingURL=data:application/json', named);
          if (named < 0 || at < 0 || at < text.lastIndexOf('eval(', named)) return null;
          const b64 = /;base64,([A-Za-z0-9+/=]+)/.exec(text.slice(at, named))?.[1];
          return b64 ? parseMap(JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))) : null;
        },
        () => null,
      );
      if (this.evalMaps.size > 200) this.evalMaps.clear();
      this.evalMaps.set(key, map);
    }
    return map;
  }

  /**
   * A place in one of webpack's eval'd modules ("webpack-internal:///(app-pages-browser)/./src/x.tsx:12:5") → its
   * source, through the module's own map. Its line counts the module's compiled code, not the file's. Null when the
   * chunk isn't on disk (most dev servers keep chunks in memory).
   */
  async mapEval(at: string): Promise<string | null> {
    // React marks a server component's frames with a count ("?20"): not part of the module's name.
    const m = /^(webpack-internal:\/\/\/.+?)(?:\?\d+)?:(\d+):(\d+)$/.exec(at);
    const map = m ? await this.evalMap(m[1]).catch(() => null) : null;
    const hit = map && lookup(map, Number(m![2]) - 1, Number(m![3]) - 1);
    return hit ? this.relative(cleanSource(hit.source, null), hit.line, hit.column) : null;
  }

  /** In the project, or in a package of the workspace it is part of ("../packages/ui/Button.tsx"); never a library's. */
  private relative(file: string, line: number, col: number): string | null {
    const abs = path.isAbsolute(file) ? file : path.join(this.project.root, file);
    const rel = path.relative(this.project.root, abs).split(path.sep).join('/');
    if (!rel || path.isAbsolute(rel) || !inProject(this.project.root, rel)) return null;
    return `${rel}:${line}:${col}`;
  }

  /** Rewrite the frames of a stack trace that lead to the project's own source. */
  async mapStack(stack: string): Promise<string> {
    const frames = [...stack.matchAll(/((?:https?:\/\/[^\s()]+|file:\/\/[^\s()]+|\/[^\s():]+)):(\d+):(\d+)/g)];
    let out = stack;
    for (const f of frames.slice(0, 12)) {
      const mapped = await this.map(`${f[1]}:${f[2]}:${f[3]}`);
      if (mapped) out = out.replace(f[0], mapped);
    }
    return out;
  }
}
