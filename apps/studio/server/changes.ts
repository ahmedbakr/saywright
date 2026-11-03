import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Change, ChangeSource, RefInfo } from '../shared/api.ts';
import { BRAND } from '../shared/brand.ts';
import { diffFile } from './diff.ts';
import { writeFileAtomic } from './fsx.ts';
import { HttpError } from './http.ts';
import type { Project } from './project.ts';

export interface FileEdit {
  path: string;
  /** Content before the change, or null when the change creates the file. */
  before: string | null;
  after: string;
}

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

/** What survives a restart: the changes, and the file contents of those still in preview (so they can be undone). */
interface Journal {
  v: 1;
  changes: Change[];
  edits: Record<string, FileEdit[]>;
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
 *
 * The list is journaled in the app's data folder before any file is touched, so previews outlive a restart or a
 * crash of the studio: they come back as previews, still undoable.
 */
export class ChangeStore {
  private changes: Change[] = [];
  private edits = new Map<string, FileEdit[]>();
  private readonly journal: string;
  /** Previews found waiting from an earlier run of the studio. */
  readonly restored: number;

  /** One change at a time: a preview or an undo has written its files before the next one starts. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private project: Project,
    private holdUpdates: HoldUpdates = holdPageUpdates,
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
   * moved in: a page never runs half of a change.
   */
  private async land(files: { path: string; content: string | null }[]): Promise<void> {
    if (files.length > 1) await this.holdUpdates(this.project.url, files.map((f) => this.project.resolve(f.path)));
    writeTogether(this.project, files);
  }

  private current(rel: string): string | null {
    return this.project.exists(rel) ? this.project.read(rel) : null;
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
    const edits = input.edits.filter((e) => e.before !== e.after);
    if (!edits.length) throw new HttpError(422, 'That change would not modify any file');
    const change: Change = {
      id: randomUUID().slice(0, 8),
      title: input.title,
      summary: input.summary,
      said: input.said,
      refs: input.refs,
      source: input.source,
      model: input.model,
      files: edits.map((e) => diffFile(e.path, e.before, e.after)),
      status: 'preview',
      createdAt: Date.now(),
      latencyMs: input.latencyMs,
    };
    // Journal first: if the studio stops halfway, the next start still knows what was being written.
    this.changes.push(change);
    this.edits.set(change.id, edits);
    this.save();
    try {
      await this.land(edits.map((e) => ({ path: e.path, content: e.after })));
    } catch (err) {
      // Put back any file already in place, so the project is never half-changed.
      for (const e of edits) {
        if (this.current(e.path) !== e.after) continue;
        if (e.before === null) this.project.remove(e.path);
        else this.project.write(e.path, e.before);
      }
      this.changes.pop();
      this.edits.delete(change.id);
      this.save();
      throw err;
    }
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

    if (!opts.force) {
      // Simulate the rollback in memory to make sure nothing else touched these files.
      const expected = new Map<string, string | null>();
      for (const c of stack) {
        for (const e of (this.edits.get(c.id) ?? []).slice().reverse()) {
          const current = expected.has(e.path) ? expected.get(e.path)! : this.project.exists(e.path) ? this.project.read(e.path) : null;
          if (current !== e.after) {
            throw new HttpError(409, `${e.path} was edited after this change, so undoing it here could lose work. Undo it in your editor instead.`, 'conflict');
          }
          expected.set(e.path, e.before);
        }
      }
    }

    // Each file as it was before the oldest of these changes, put back together.
    const restored = new Map<string, string | null>();
    for (const c of stack) for (const e of (this.edits.get(c.id) ?? []).slice().reverse()) restored.set(e.path, e.before);
    await this.land([...restored].map(([p, content]) => ({ path: p, content })));
    const now = Date.now();
    for (const c of stack) {
      c.status = 'undone';
      c.decidedAt = now;
    }
    this.save();
    return stack;
  }

  /** Write the journal, never half-written. Only previews keep their file contents: kept and undone changes are history. */
  private save(): void {
    const previews = new Set(this.previews().map((c) => c.id));
    const changes = this.changes.filter((c, i) => previews.has(c.id) || i >= this.changes.length - HISTORY);
    const edits: Journal['edits'] = {};
    for (const id of previews) edits[id] = this.edits.get(id) ?? [];
    const journal: Journal = { v: 1, changes, edits };
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
      if (journal.v !== 1 || !Array.isArray(journal.changes)) return 0;
    } catch {
      return 0; // first run, or nothing to restore
    }
    const now = Date.now();
    const current = (p: string) => (this.project.exists(p) ? this.project.read(p) : null);
    for (const c of journal.changes) {
      const edits = journal.edits?.[c.id];
      if (c.status === 'preview') {
        const found = edits?.map((e) => current(e.path)) ?? [];
        if (!edits?.length) {
          c.status = 'kept';
          c.decidedAt = now;
        } else if (edits.every((e, i) => found[i] === e.before || found[i] === e.after) && !edits.every((e, i) => found[i] === e.after)) {
          // Stopped before or halfway through writing it (or reverted by hand): put back what was written, so it
          // never half-applies.
          edits.forEach((e, i) => {
            if (found[i] !== e.after) return;
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
function writeTogether(project: Project, files: { path: string; content: string | null }[]): void {
  const staged: { abs: string; tmp: string | null }[] = [];
  try {
    for (const f of files) {
      const abs = project.resolve(f.path);
      if (f.content === null) {
        staged.push({ abs, tmp: null });
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.saywright-tmp`;
      fs.writeFileSync(tmp, f.content);
      staged.push({ abs, tmp });
    }
  } catch (err) {
    for (const s of staged) if (s.tmp) fs.rmSync(s.tmp, { force: true });
    throw err;
  }
  for (const s of staged) {
    if (s.tmp) fs.renameSync(s.tmp, s.abs);
    else fs.rmSync(s.abs, { force: true });
    project.code.forget(project.rel(s.abs));
  }
}
