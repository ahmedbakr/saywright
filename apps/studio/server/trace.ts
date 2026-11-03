/**
 * From what the page says about an element to where it is in the project. The Vite plugin's attribute is taken
 * as it is; React's frames are followed through source maps (the element's own JSX, or where the components that
 * pass it their props were used, skipping libraries' code); a search of the code for what the page shows comes
 * last, and what it finds is a guess, said to be one.
 */
import { parseSrc, type SourceFrame, type SourceHint } from '@saywright/vite/protocol';
import { findInComponent, findWritten, inProject, locateElement, projectFiles, startOfTag, type CodeFiles, type Findable } from './locate.ts';
import type { Project } from './project.ts';
import type { SourceMapper } from './sessions/sourcemap.ts';

/** What a request or the studio's page sends about an element (unchecked). */
export interface Traceable {
  src?: unknown;
  frames?: unknown;
  hint?: unknown;
  tag?: unknown;
  text?: unknown;
  /** Traced before and found by a search: it stays a guess. */
  guessed?: unknown;
}

interface Traced {
  /** "src/App.tsx:12:5", relative to the project (a sibling package's file starts with "../"), or null. */
  src: string | null;
  /** Found by searching the code, or picked among several places that fit: likely, not certain. */
  guessed: boolean;
}

/** A file path as plugins and frameworks report it ("src/app/(main)/page.tsx:12:5"). */
const PLAIN = /^[\w@./+()[\] -]+\.([cm]?[jt]sx?|vue|svelte|astro|html?|mdx?):\d+:\d+$/;

/** What identifies the element, as the page sent it (checked). */
function findable(ref: Traceable): Findable {
  const raw = (ref.hint && typeof ref.hint === 'object' ? ref.hint : {}) as { attrs?: unknown; file?: unknown };
  const attrs: Record<string, string> = {};
  if (raw.attrs && typeof raw.attrs === 'object') {
    for (const [k, v] of Object.entries(raw.attrs as Record<string, unknown>).slice(0, 16)) if (/^[\w:-]{1,30}$/.test(k) && typeof v === 'string') attrs[k] = v.slice(0, 200);
  }
  const hint: SourceHint = typeof raw.file === 'string' && raw.file.length <= 400 ? { attrs, file: raw.file } : { attrs };
  return { tag: typeof ref.tag === 'string' ? ref.tag.slice(0, 30) : undefined, text: typeof ref.text === 'string' ? ref.text.slice(0, 200) : undefined, hint };
}

/** The frames a page sent, checked: at most ten, each a position and what is written there. */
export function frameList(raw: unknown): SourceFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceFrame[] = [];
  for (const f of raw.slice(0, 10)) {
    const o = (f ?? {}) as Record<string, unknown>;
    if (typeof o.at !== 'string' || !o.at || o.at.length > 600) continue;
    const frame: SourceFrame = { at: o.at };
    if (typeof o.name === 'string' && /^[\w$.:-]{1,80}$/.test(o.name)) frame.name = o.name;
    if (o.inside === true) frame.inside = true;
    if (o.root === true) frame.root = true;
    out.push(frame);
  }
  return out;
}

export class Tracer {
  readonly files: CodeFiles;

  constructor(
    private project: Project,
    private mapper: SourceMapper | null,
    files?: CodeFiles,
  ) {
    this.files = files ?? projectFiles(project);
  }

  /**
   * A position the page reported, in the project's code: `exact` when its line is the source's. Webpack's eval'd
   * modules name their file but count lines in the code they run. Null for a library's code or what can't be mapped.
   */
  async position(at: string): Promise<{ file: string; line: number; col: number; exact: boolean } | null> {
    const wp = /^webpack-internal:\/\/\/(?:\([^)]*\)\/)?\.\/(.+?)(?:\?[^:]*)?:(\d+):(\d+)$/.exec(at);
    if (wp) {
      if (!inProject(this.project.root, wp[1])) return null;
      // Through the module's own source map when its chunk is on disk; else the file is right and the line is found.
      const mapped = this.mapper ? parseSrc((await this.mapper.mapEval(at).catch(() => null)) ?? '') : null;
      if (mapped && inProject(this.project.root, mapped.file)) return { ...mapped, exact: true };
      return { file: wp[1], line: Number(wp[2]), col: Number(wp[3]), exact: false };
    }
    let src: string | null = null;
    // A file of the project as it is (the plugin's attributes); anything else is a place in served code to map.
    if (PLAIN.test(at) && !at.startsWith('/') && !at.includes('/.next/') && this.project.exists(parseSrc(at)!.file)) src = at;
    else if (this.mapper) src = await this.mapper.map(at.slice(0, 600)).catch(() => null);
    const p = src ? parseSrc(src) : null;
    return p && inProject(this.project.root, p.file) ? { ...p, exact: true } : null;
  }

  /** "file:line:col" in the project for a position the page reported, or null. */
  async toSource(at: unknown): Promise<string | null> {
    if (typeof at !== 'string' || !at) return null;
    const p = await this.position(at);
    return p?.exact ? `${p.file}:${p.line}:${p.col}` : null;
  }

  /** Where an element is written: as the page says, mapped, or found by its text (a guess). */
  async trace(ref: Traceable, pageUrl?: string): Promise<Traced> {
    if (!this.project.hasCode) return { src: null, guessed: false };
    const el = findable(ref);
    const frames = frameList(ref.frames);
    if (frames.length) {
      const found = await this.fromFrames(frames, el);
      if (found) return found;
    } else if (typeof ref.src === 'string' && ref.src) {
      const found = await this.frame({ at: ref.src, name: el.tag }, el);
      if (found) return ref.guessed === true ? { ...found, guessed: true } : found;
    }
    if (ref.hint) {
      const src = await locateElement(this.files, el, { pageUrl, root: this.project.root }).catch(() => null);
      if (src) return { src, guessed: true };
    }
    return { src: null, guessed: false };
  }

  /**
   * The first frame in the project (the element's own JSX, else where the component that rendered it was used);
   * then, like the plugin's instance sites, on to where each component that passes the element its props was used,
   * in its own file or another.
   */
  private async fromFrames(frames: SourceFrame[], el: Findable): Promise<Traced | null> {
    let pick: Traced | null = null;
    for (const [i, f] of frames.entries()) {
      // Further out, only components the element is the outermost element of say anything about it.
      if (!f.root && (pick || i > 1)) break;
      let found = await this.frame(f, el);
      if (!found?.src) continue;
      // React 19.0 couldn't place the component the element is in (it ran without failing): where it is used leads to it.
      if (i === 0 && f.inside && !f.root && f.name && el.tag && f.name !== el.tag) {
        const inner = await findInComponent(this.files, parseSrc(found.src)!.file, f.name, el.tag, el).catch(() => null);
        if (inner) found = { src: inner.src, guessed: !inner.sure };
      }
      pick = found;
    }
    return pick;
  }

  private async frame(f: SourceFrame, el: Findable): Promise<Traced | null> {
    const p = await this.position(f.at);
    if (!p) return null;
    if (p.exact && !f.inside) return { src: (await startOfTag(this.files, p.file, p.line, p.col)) ?? `${p.file}:${p.line}:${p.col}`, guessed: false };
    if (!f.name) return null;
    // React named the file and what is written there, not the line: find it.
    const found = await findWritten(this.files, p.file, f.name, el, f.inside && p.exact ? p : undefined).catch(() => null);
    return found ? { src: found.src, guessed: !found.sure } : null;
  }
}
