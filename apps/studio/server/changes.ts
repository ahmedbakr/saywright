import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Change, ChangeSource, RefInfo } from '../shared/api.ts';
import { BRAND } from '../shared/brand.ts';
import { diffFile } from './diff.ts';
import { writeBeside, writeFileAtomic } from './fsx.ts';
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
 * base64 of their bytes. Version 3 keeps each preview's contents in a file of its own beside the list
 * (`changes.d/<id>.json`), written once: a new preview never writes the others' again. Versions 1 (0.2.x, as text,
 * read as the UTF-8 it was written from) and 2 kept them all in the list.
 */
interface Journal {
  v: 1 | 2 | 3;
  changes: Change[];
  edits?: Record<string, JournalEdit[]>;
}
type JournalEdit = { path: string; before: string | null; after: string };

/** Changes listed, in this run and after a restart (previews are always kept). */
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
  /**
   * What Undo needs is kept for the most recent kept changes, within this allowance: a studio open all day doesn't
   * keep a copy of every file it ever changed. Older kept changes say they can no longer be undone here.
   */
  static undoAllowance = { changes: 20, bytes: 32 * 1024 * 1024 };

  private changes: Change[] = [];
  private edits = new Map<string, StoredEdit[]>();
  private readonly journal: string;
  /** Each waiting preview's file contents, one file per preview. */
  private readonly contents: string;
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
    this.contents = path.join(path.dirname(this.journal), 'changes.d');
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

  /**
   * Older changes let go: what Undo needs is kept for every preview, and for the most recent kept changes within the
   * allowance; the list itself keeps the last HISTORY changes (and every preview). Each change says whether it can
   * still be undone here.
   */
  private trim(): void {
    const { changes: most, bytes } = ChangeStore.undoAllowance;
    let count = 0;
    let size = 0;
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i];
      const edits = this.edits.get(c.id);
      if (c.status === 'kept' && edits) {
        const own = edits.reduce((n, e) => n + (e.before?.length ?? 0) + e.after.length, 0);
        if (count < most && size + own <= bytes) {
          count++;
          size += own;
        } else this.edits.delete(c.id);
      } else if (c.status === 'undone') this.edits.delete(c.id);
      c.undoable = c.status !== 'undone' && this.edits.has(c.id);
    }
    const over = this.changes.length - HISTORY;
    if (over > 0) {
      const drop = new Set(this.changes.slice(0, over).filter((c) => c.status !== 'preview'));
      this.changes = this.changes.filter((c) => !drop.has(c));
    }
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
    this.project.checkRoot();
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
    // Journal first: if the studio stops halfway, the next start still knows what was being written. A journal that
    // can't be written stops it here, with nothing written and nothing listed.
    this.changes.push(change);
    this.edits.set(change.id, edits);
    try {
      this.save('nothing was written', () => this.saveContents(change.id, edits));
    } catch (err) {
      this.changes.pop();
      this.edits.delete(change.id);
      this.forgetContents([change.id]);
      throw err;
    }
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
      this.saveIfCan();
      this.forgetContents([change.id]);
      throw writeError(err, change.files.map((f) => f.path));
    }
    this.trim();
    this.onUpdate();
    return change;
  }

  /** Keep a preview and every preview made before it (later ones were built on top of them). */
  keep(id?: string): { kept: Change[] } {
    this.project.checkRoot();
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
    try {
      this.save('nothing was kept');
    } catch (err) {
      // Not recorded, so not kept: still previews, as the journal says.
      for (const c of kept) {
        c.status = 'preview';
        c.decidedAt = undefined;
      }
      throw err;
    }
    this.forgetContents(kept.map((c) => c.id));
    this.trim();
    this.onUpdate();
    return { kept };
  }

  /**
   * Commit changes just kept, as one commit (when the app is a git repository): each file as the oldest of them found
   * it and as the newest left it, and only those files. `error` says why git refused; `note`, why nothing was tried.
   */
  async commit(kept: Change[]): Promise<{ committed: boolean; error?: string; note?: string }> {
    if (!kept.length || !this.project.isGit) return { committed: false };
    const files = new Map<string, { path: string; before: Buffer | null; after: Buffer }>();
    for (const c of kept) {
      const edits = this.edits.get(c.id);
      if (!edits) return { committed: false, note: `Kept, not committed: “${c.title}” was made in an earlier run of the studio, so what it changed can’t be told from your own edits.` };
      for (const e of edits) {
        const known = files.get(e.path);
        files.set(e.path, { path: e.path, before: known ? known.before : e.before, after: e.after });
      }
    }
    const title = kept.length === 1 ? kept[0].title : `${kept.length} changes from ${BRAND.name}`;
    const said = kept.map((c) => c.said).filter(Boolean);
    return this.project.commit([...files.values()], `${title}\n\nMade with ${BRAND.name}${said.length ? `\n${said.map((s) => `- "${s}"`).join('\n')}` : ''}`);
  }

  /** Undo the newest preview, or a specific change (newer previews are undone first). */
  undo(id?: string, opts: { force?: boolean } = {}): Promise<Change[]> {
    return this.serial(() => this.putBack(id, opts));
  }

  private async putBack(id: string | undefined, opts: { force?: boolean }): Promise<Change[]> {
    this.project.checkRoot();
    const target = id ? this.get(id) : this.previews().at(-1);
    if (!target) throw new HttpError(409, 'Nothing to undo');
    if (target.status === 'undone') throw new HttpError(409, 'That change was already undone');
    const index = this.changes.indexOf(target);
    const stack = this.changes.slice(index).filter((c) => c === target || c.status === 'preview').reverse();
    if (stack.some((c) => !this.edits.has(c.id))) {
      const { changes: most } = ChangeStore.undoAllowance;
      throw new HttpError(409, `That change can no longer be undone here: the studio keeps what Undo needs only for the last ${most} changes you kept while it runs, and this one is older, or was kept in an earlier run of the studio. Undo it in your editor or with git.`, 'too-old');
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
    // The files are back. A journal that can't say so yet is no harm: the next start finds them as they were before
    // these changes and counts them undone.
    this.saveIfCan();
    this.forgetContents(stack.map((c) => c.id));
    this.trim();
    this.onUpdate();
    return stack;
  }

  /** Write the journal; when it can't be (a full disk, a folder that can't be written), why, and `then`, in words. */
  private save(then = 'nothing was changed', first?: () => void): void {
    try {
      first?.();
      this.saveJournal();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const why = code === 'ENOSPC' ? 'the disk is full' : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'that folder can’t be written' : (err as Error).message;
      throw new HttpError(507, `The studio couldn’t save its list of changes in ${path.dirname(this.journal)} (${why}), so ${then}. Free some space or fix the folder’s permissions, then try again.`, 'journal');
    }
  }

  private saveIfCan(): void {
    try {
      this.saveJournal();
    } catch (err) {
      console.warn(`[saywright] couldn’t save the list of changes: ${(err as Error).message}`);
    }
  }

  /**
   * Write the list of changes, never half-written. Only previews keep their file contents (each in its own file,
   * written once with the preview): kept and undone changes are history.
   */
  private saveJournal(): void {
    const previews = new Set(this.previews().map((c) => c.id));
    const changes = this.changes.filter((c, i) => previews.has(c.id) || i >= this.changes.length - HISTORY).map((c) => ({ ...c, undoable: undefined }));
    const journal: Journal = { v: 3, changes };
    writeFileAtomic(this.journal, JSON.stringify(journal));
  }

  /** A preview's file contents, beside the list, before the list names it. */
  private saveContents(id: string, edits: StoredEdit[]): void {
    const data: JournalEdit[] = edits.map((e) => ({ path: e.path, before: e.before?.toString('base64') ?? null, after: e.after.toString('base64') }));
    writeFileAtomic(path.join(this.contents, `${id}.json`), JSON.stringify(data));
  }

  /** The contents of changes no longer waiting: not needed after a restart. */
  private forgetContents(ids: string[]): void {
    for (const id of ids) fs.rmSync(path.join(this.contents, `${id}.json`), { force: true });
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
      if ((journal.v !== 1 && journal.v !== 2 && journal.v !== 3) || !Array.isArray(journal.changes)) return 0;
    } catch {
      return 0; // first run, or nothing to restore
    }
    const now = Date.now();
    const bytes = (text: string) => Buffer.from(text, journal.v === 1 ? 'utf8' : 'base64');
    const stored = (id: string): JournalEdit[] | undefined => {
      if (journal.v !== 3) return journal.edits?.[id];
      try {
        return JSON.parse(fs.readFileSync(path.join(this.contents, `${id}.json`), 'utf8')) as JournalEdit[];
      } catch {
        return undefined;
      }
    };
    for (const c of journal.changes) {
      const edits = c.status === 'preview' ? stored(c.id)?.map((e): StoredEdit => ({ path: e.path, before: e.before === null ? null : bytes(e.before), after: bytes(e.after) })) : undefined;
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
    this.trim();
    // A journal of an earlier version is written as this one: each waiting preview's contents in a file of its own.
    try {
      for (const c of this.previews()) if (journal.v !== 3) this.saveContents(c.id, this.edits.get(c.id) ?? []);
      this.saveJournal();
      const waitingIds = new Set(this.previews().map((c) => `${c.id}.json`));
      for (const f of fs.existsSync(this.contents) ? fs.readdirSync(this.contents) : []) if (!waitingIds.has(f)) fs.rmSync(path.join(this.contents, f), { force: true });
    } catch (err) {
      console.warn(`[saywright] couldn’t save the list of changes: ${(err as Error).message}`);
    }
    return waiting;
  }
}

/** A file that couldn't be written (a full disk, a folder that can't be written), in words; other errors as they are. */
function writeError(err: unknown, files: string[]): unknown {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code !== 'ENOSPC' && code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') return err;
  const why = code === 'ENOSPC' ? 'the disk is full' : 'the folder can’t be written';
  return new HttpError(507, `Couldn’t write ${files.join(', ')} (${why}), so the change wasn’t made and nothing was written.`, 'write');
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
      writeBeside(tmp, abs, f.content);
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
