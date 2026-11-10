import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Change, ChangeSource, RefInfo } from '../shared/api.ts';
import { BRAND } from '../shared/brand.ts';
import { diffFile } from './diff.ts';
import { writeFileAtomic } from './fsx.ts';
import { HttpError } from './http.ts';
import type { Project } from './project.ts';
import { EncodingError, NotTextError, decodeText, encodeText } from './text-file.ts';

/** One file of a change, as whoever made it read and wrote it: text. */
export interface FileEdit {
  path: string;
  /** Content before the change, or null when the change creates the file. */
  before: string | null;
  after: string;
}

/**
 * One file of a change as the store keeps it: the file's own bytes before, and the bytes written. Undo puts back
 * exactly what was there, whatever the file's encoding or line ends, and "is it still as we left it" is asked of
 * bytes, never of text read back.
 */
interface StoredEdit {
  path: string;
  before: Buffer | null;
  after: Buffer;
}

const sameBytes = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

interface NewChange {
  title: string;
  summary?: string;
  said?: string;
  refs?: RefInfo[];
  source: ChangeSource;
  model?: string;
  edits: FileEdit[];
  latencyMs?: number;
}

/**
 * What survives a restart: the changes, and the file contents of those still in preview (so they can be undone), as
 * base64 of their bytes. Version 1 (0.2.x) kept them as text: read as the UTF-8 it was written from.
 */
interface Journal {
  v: 1 | 2;
  changes: Change[];
  edits: Record<string, { path: string; before: string | null; after: string }[]>;
}

/** Changes listed after a restart (previews are always kept). */
const HISTORY = 200;

/**
 * Every change is written to disk at once so the live app shows it (the dev
 * server hot-reloads), but it stays a *preview* until the user keeps it.
 *
 * Previews stack: "make this bigger", then "and red", then "keep it" keeps
 * both. Undo always peels off the newest preview first, restoring the exact
 * previous content, and refuses if the file was edited elsewhere meanwhile.
 * A change is written only over the files it was made from: one saved while it
 * was being made is never written over.
 *
 * The list is journaled in the app's data folder before any file is touched, so previews outlive a restart or a
 * crash of the studio: they come back as previews, still undoable.
 */
export class ChangeStore {
  private changes: Change[] = [];
  private edits = new Map<string, StoredEdit[]>();
  private readonly journal: string;
  /** Previews found waiting from an earlier run of the studio. */
  readonly restored: number;

  /** One change at a time: a preview or an undo has written its files before the next one starts. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private project: Project,
    private holdUpdates: HoldUpdates = holdPageUpdates,
    /** After a preview is written, kept or undone: every open studio tab catches up. */
    private onUpdate: () => void = () => undefined,
  ) {
    this.journal = path.join(project.stateDir(), 'changes.json');
    this.restored = this.restore();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Put files in place as one change. With several, the app's dev server is asked first to hold the page's updates
   * until all of them are written (the Saywright plugin does), and each is written beside its place before any is
   * moved in: a page never runs half of a change. `check` runs last, right before the writing, with nothing waited
   * on in between: what it finds is what is written over.
   */
  private async land(files: { path: string; content: Buffer | null }[], check: () => void = () => undefined): Promise<void> {
    if (files.length > 1) await this.holdUpdates(this.project.url, files.map((f) => this.project.resolve(f.path)));
    check();
    writeTogether(this.project, files);
  }

  /** Refused: the file isn't what the change was made from any more. */
  private stale(e: { path: string; before: unknown }): HttpError {
    const what = e.before === null ? `${e.path} was created` : this.project.exists(e.path) ? `${e.path} changed` : `${e.path} was deleted`;
    return new HttpError(409, `${what} while this change was being made (in your editor, or by another change), so it wasn’t written and nothing was lost. Ask again to make it on the file as it is now.`, 'stale');
  }

  /**
   * A change's files as bytes: each file's own bytes now, which must read as the text the change was made from
   * (otherwise it was written since: refused), and the new text written the way the file is (its encoding kept). A
   * file that isn't UTF-8 can only take the characters its encoding has: a change that adds another is refused, with
   * what to do, rather than written as something else.
   */
  private encode(edits: FileEdit[]): StoredEdit[] {
    return edits.map((e) => {
      const bytes = this.current(e.path);
      if (e.before === null || bytes === null) {
        if (e.before !== null || bytes !== null) throw this.stale(e);
        return { path: e.path, before: null, after: Buffer.from(e.after, 'utf8') };
      }
      let read: ReturnType<typeof decodeText>;
      try {
        read = decodeText(bytes, e.path);
      } catch (err) {
        throw err instanceof NotTextError ? new HttpError(400, err.message, 'not-text') : err;
      }
      if (read.text !== e.before) throw this.stale(e);
      try {
        return { path: e.path, before: bytes, after: encodeText(e.after, read.encoding) };
      } catch (err) {
        if (!(err instanceof EncodingError)) throw err;
        throw new HttpError(409, `${e.path} isn’t saved as UTF-8, and this change adds a character its encoding can’t hold: ${err.message}. Nothing was written. Save the file as UTF-8 in your editor, then ask again.`, 'encoding');
      }
    });
  }

  /**
   * Each file still holds the bytes the change was made from. Otherwise it was written since (in an editor, by a
   * formatter, by another change), and writing the change would lose that: it is refused, and nothing is written.
   */
  private unchanged(edits: StoredEdit[]): void {
    for (const e of edits) if (!sameBytes(this.current(e.path), e.before)) throw this.stale(e);
  }

  /** A file's bytes now, or null when there is no such file. */
  private current(rel: string): Buffer | null {
    return this.project.exists(rel) ? this.project.readBytes(rel) : null;
  }

  list(): Change[] {
    return this.changes.slice().reverse();
  }

  get(id: string): Change {
    const c = this.changes.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'No such change');
    return c;
  }

  previews(): Change[] {
    return this.changes.filter((c) => c.status === 'preview');
  }

  preview(input: NewChange): Promise<Change> {
    return this.serial(() => this.write(input));
  }

  private async write(input: NewChange): Promise<Change> {
    const texts = input.edits.filter((e) => e.before !== e.after);
    if (!texts.length) throw new HttpError(422, 'That change would not modify any file');
    const edits = this.encode(texts);
    const change: Change = {
      id: randomUUID().slice(0, 8),
      title: input.title,
      summary: input.summary,
      said: input.said,
      refs: input.refs,
      source: input.source,
      model: input.model,
      files: texts.map((e) => diffFile(e.path, e.before, e.after)),
      status: 'preview',
      createdAt: Date.now(),
      latencyMs: input.latencyMs,
    };
    // Journal first: if the studio stops halfway, the next start still knows what was being written.
    this.changes.push(change);
    this.edits.set(change.id, edits);
    this.save();
    let writing = false;
    try {
      // Checked again once the page's updates are held: a file saved meanwhile is never written over.
      await this.land(
        edits.map((e) => ({ path: e.path, content: e.after })),
        () => {
          this.unchanged(edits);
          writing = true;
        },
      );
    } catch (err) {
      // Put back any file already in place, so the project is never half-changed (none was, when it was refused).
      for (const e of writing ? edits : []) {
        if (!sameBytes(this.current(e.path), e.after)) continue;
        if (e.before === null) this.project.remove(e.path);
        else this.project.write(e.path, e.before);
      }
      this.changes.pop();
      this.edits.delete(change.id);
      this.save();
      throw err;
    }
    this.onUpdate();
    return change;
  }

  /** Keep a preview and every preview made before it (later ones were built on top of them). */
  keep(id?: string): { kept: Change[] } {
    const previews = this.previews();
    if (!previews.length) throw new HttpError(409, 'Nothing is waiting to be kept');
    const upto = id ? previews.findIndex((c) => c.id === id) : previews.length - 1;
    if (upto < 0) throw new HttpError(409, 'That change is not a preview');
    const kept = previews.slice(0, upto + 1);
    const now = Date.now();
    for (const c of kept) {
      c.status = 'kept';
      c.decidedAt = now;
    }
    this.save();
    this.onUpdate();
    return { kept };
  }

  /** Commit changes just kept, as one commit (when the app is a git repository); `error` says why it didn't. */
  async commit(kept: Change[]): Promise<{ committed: boolean; error?: string }> {
    if (!kept.length || !this.project.isGit) return { committed: false };
    const files = [...new Set(kept.flatMap((c) => c.files.map((f) => f.path)))];
    const title = kept.length === 1 ? kept[0].title : `${kept.length} changes from ${BRAND.name}`;
    const said = kept.map((c) => c.said).filter(Boolean);
    return this.project.commit(files, `${title}\n\nMade with ${BRAND.name}${said.length ? `\n${said.map((s) => `- "${s}"`).join('\n')}` : ''}`);
  }

  /** Undo the newest preview, or a specific change (newer previews are undone first). */
  undo(id?: string, opts: { force?: boolean } = {}): Promise<Change[]> {
    return this.serial(() => this.putBack(id, opts));
  }

  private async putBack(id: string | undefined, opts: { force?: boolean }): Promise<Change[]> {
    const target = id ? this.get(id) : this.previews().at(-1);
    if (!target) throw new HttpError(409, 'Nothing to undo');
    if (target.status === 'undone') throw new HttpError(409, 'That change was already undone');
    const index = this.changes.indexOf(target);
    const stack = this.changes.slice(index).filter((c) => c === target || c.status === 'preview').reverse();
    if (stack.some((c) => !this.edits.has(c.id))) {
      throw new HttpError(409, 'That change was kept in an earlier run of the studio, so its previous code isn’t stored any more. Undo it in your editor or with git.');
    }

    // Simulate the rollback in memory to make sure nothing else touched these files: before, and again right before
    // the files are written.
    const untouched = () => {
      const expected = new Map<string, Buffer | null>();
      for (const c of stack) {
        for (const e of (this.edits.get(c.id) ?? []).slice().reverse()) {
          const current = expected.has(e.path) ? expected.get(e.path)! : this.current(e.path);
          if (!sameBytes(current, e.after)) {
            throw new HttpError(409, `${e.path} was edited after this change, so undoing it here could lose work. Undo it in your editor instead.`, 'conflict');
          }
          expected.set(e.path, e.before);
        }
      }
    };
    if (!opts.force) untouched();

    // Each file as it was before the oldest of these changes, byte for byte, put back together.
    const restored = new Map<string, Buffer | null>();
    for (const c of stack) for (const e of (this.edits.get(c.id) ?? []).slice().reverse()) restored.set(e.path, e.before);
    await this.land(
      [...restored].map(([p, content]) => ({ path: p, content })),
      opts.force ? undefined : untouched,
    );
    const now = Date.now();
    for (const c of stack) {
      c.status = 'undone';
      c.decidedAt = now;
    }
    this.save();
    this.onUpdate();
    return stack;
  }

  /** Write the journal, never half-written. Only previews keep their file contents: kept and undone changes are history. */
  private save(): void {
    const previews = new Set(this.previews().map((c) => c.id));
    const changes = this.changes.filter((c, i) => previews.has(c.id) || i >= this.changes.length - HISTORY);
    const edits: Journal['edits'] = {};
    for (const id of previews) edits[id] = (this.edits.get(id) ?? []).map((e) => ({ path: e.path, before: e.before?.toString('base64') ?? null, after: e.after.toString('base64') }));
    const journal: Journal = { v: 2, changes, edits };
    writeFileAtomic(this.journal, JSON.stringify(journal));
  }

  /**
   * Read the journal an earlier run left. A preview whose files still hold what it wrote is waiting again; one whose
   * files hold only what was there before or what it wrote (the run stopped before or while writing it, or someone
   * reverted it) is put back and counts as undone. Returns how many previews are waiting.
   */
  private restore(): number {
    let journal: Journal;
    try {
      journal = JSON.parse(fs.readFileSync(this.journal, 'utf8')) as Journal;
      if ((journal.v !== 1 && journal.v !== 2) || !Array.isArray(journal.changes)) return 0;
    } catch {
      return 0; // first run, or nothing to restore
    }
    const now = Date.now();
    const bytes = (text: string) => Buffer.from(text, journal.v === 1 ? 'utf8' : 'base64');
    for (const c of journal.changes) {
      const edits = journal.edits?.[c.id]?.map((e): StoredEdit => ({ path: e.path, before: e.before === null ? null : bytes(e.before), after: bytes(e.after) }));
      if (c.status === 'preview') {
        const found = edits?.map((e) => this.current(e.path)) ?? [];
        if (!edits?.length) {
          c.status = 'kept';
          c.decidedAt = now;
        } else if (edits.every((e, i) => sameBytes(found[i], e.before) || sameBytes(found[i], e.after)) && !edits.every((e, i) => sameBytes(found[i], e.after))) {
          // Stopped before or halfway through writing it (or reverted by hand): put back what was written, so it
          // never half-applies.
          edits.forEach((e, i) => {
            if (!sameBytes(found[i], e.after)) return;
            if (e.before === null) this.project.remove(e.path);
            else this.project.write(e.path, e.before);
          });
          c.status = 'undone';
          c.decidedAt = now;
        } else {
          this.edits.set(c.id, edits);
        }
      }
      this.changes.push(c);
    }
    const waiting = this.previews().length;
    this.save();
    return waiting;
  }
}

/** Asks the dev server at `url` to hold the page's updates while these files (absolute paths) are written; resolves once it has, or can't. */
type HoldUpdates = (url: string, files: string[]) => Promise<void>;

/** Dev servers with the Saywright plugin (which can hold a page's updates), by address, and when that was last asked. */
const withPlugin = new Map<string, { at: number; yes: boolean }>();

/** The Saywright plugin's way: a short request that waits for nothing else (an app without the plugin is written to as it is). */
async function holdPageUpdates(url: string, files: string[]): Promise<void> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  const known = withPlugin.get(origin);
  if (!known || Date.now() - known.at > 30_000) {
    const yes = await fetch(`${origin}/__saywright/info`, { signal: AbortSignal.timeout(800) })
      .then((r) => r.ok && /json/.test(r.headers.get('content-type') ?? ''))
      .catch(() => false);
    withPlugin.set(origin, { at: Date.now(), yes });
  }
  if (!withPlugin.get(origin)?.yes) return;
  await fetch(`${origin}/__saywright/hold`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }), signal: AbortSignal.timeout(800) })
    .then((r) => r.arrayBuffer())
    .catch(() => undefined);
}

/**
 * Write files so they change together: each new version is written beside its file first (a failure there changes
 * nothing), then all are moved into place one right after another. `content` null removes the file.
 */
function writeTogether(project: Project, files: { path: string; content: Buffer | null }[]): void {
  const staged: { asked: string; abs: string; tmp: string | null }[] = [];
  try {
    for (const f of files) {
      const asked = project.resolve(f.path);
      if (f.content === null) {
        staged.push({ asked, abs: asked, tmp: null });
        continue;
      }
      // Through a link, to the file it leads to (resolve checked it), as Project.write does: moved in over the link
      // itself, the new version would replace the link with a copy and leave the real file as it was.
      let abs = asked;
      try {
        if (fs.lstatSync(asked).isSymbolicLink()) abs = fs.realpathSync(asked);
      } catch {
        /* a new file */
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.saywright-tmp`;
      fs.writeFileSync(tmp, f.content);
      staged.push({ asked, abs, tmp });
    }
  } catch (err) {
    for (const s of staged) if (s.tmp) fs.rmSync(s.tmp, { force: true });
    throw err;
  }
  for (const s of staged) {
    if (s.tmp) fs.renameSync(s.tmp, s.abs);
    else fs.rmSync(s.abs, { force: true });
    project.code.forget(project.rel(s.asked));
    if (s.abs !== s.asked) project.code.forget(project.rel(s.abs));
  }
}
