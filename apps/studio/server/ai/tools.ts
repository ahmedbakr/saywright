/**
 * The project operations Claude can use, plus validation of proposed edits.
 * Paths always go through Project.resolve, which refuses anything outside the
 * project, node_modules, .git and env files.
 */
import type { FileEdit } from '../changes.ts';
import type { Coverage } from '../code-index.ts';
import type { Project } from '../project.ts';

const MAX_READ_LINES = 400;

export function readFileTool(project: Project, path: string, start?: number, end?: number): string {
  const text = project.read(path);
  const lines = text.split('\n');
  const s = Math.max(1, Math.floor(start ?? 1));
  const e = Math.min(lines.length, Math.floor(end ?? s + MAX_READ_LINES - 1), s + MAX_READ_LINES - 1);
  if (s > lines.length) return `${path} has only ${lines.length} lines.`;
  const body = lines
    .slice(s - 1, e)
    .map((l, i) => `${String(s + i).padStart(4)}  ${l}`)
    .join('\n');
  const more = e < lines.length ? `\n… ${lines.length - e} more lines. Call read_file with start_line=${e + 1} to continue.` : '';
  return `${path} (lines ${s}-${e} of ${lines.length})\n${body}${more}`;
}

const thousands = (n: number) => n.toLocaleString('en-US');

/** What a search covered, when it wasn't everything: so "no matches" is never taken for "not in the code". */
export function coverageNote(c: Coverage): string | null {
  if (!c.timedOut && !c.tooLarge) return null;
  const why = [c.timedOut && 'it ran out of time', c.tooLarge && `${thousands(c.tooLarge)} ${c.tooLarge === 1 ? 'file was' : 'files were'} too large to search`].filter(Boolean).join(', and ');
  return `Searched ${thousands(c.searched)} of ${thousands(c.total)} files: ${why}.${c.timedOut ? ' Search a folder (dir) to cover the rest.' : ''}`;
}

/** A code search as the AI reads it, and the note on what it covered when that wasn't everything. */
export async function searchCode(project: Project, query: string, regex = false, dir = ''): Promise<{ text: string; note: string | null }> {
  const r = await project.search(query, { regex, dir, limit: 60 });
  const note = coverageNote(r);
  if (!r.hits.length) return { text: `No matches for ${JSON.stringify(query)}${dir ? ` in ${dir}` : ''}.${note ? ` ${note}` : ''}`, note };
  const lines = r.hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
  if (r.hits.length >= 60) lines.push('(The first 60 matches; make the query more specific for others.)');
  if (note) lines.push(note);
  return { text: lines.join('\n'), note };
}

export async function searchTool(project: Project, query: string, regex = false, dir = ''): Promise<string> {
  return (await searchCode(project, query, regex, dir)).text;
}

export async function listFilesTool(project: Project, dir = ''): Promise<string> {
  const folder = dir.replace(/^\.?\/?$/, '');
  const prefix = folder ? `${project.rel(project.resolve(folder))}/` : '';
  const files = (await project.code.files()).filter((f) => f.startsWith(prefix));
  if (!files.length) return `No files under ${dir || 'the project root'}.`;
  const shown = files.slice(0, 400);
  return [...shown, ...(files.length > shown.length ? [`(${thousands(shown.length)} of ${thousands(files.length)} files; list a folder (dir) to see the others.)`] : [])].join('\n');
}

interface EditSpec {
  path: string;
  old_string: string;
  new_string: string;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Turn exact-string edits into full before/after file contents. Throws an
 * Error whose message tells Claude precisely what to fix, so it can retry.
 */
export function applyEditSpecs(project: Project, specs: EditSpec[]): FileEdit[] {
  if (!specs.length) throw new Error('No edits were given.');
  if (specs.length > 25) throw new Error('Too many edits in one change; keep it focused.');
  const order: string[] = [];
  const working = new Map<string, { before: string | null; text: string }>();
  for (const spec of specs) {
    const path = spec.path.replace(/^\.\//, '');
    project.resolve(path); // throws on unsafe paths
    if (!working.has(path)) {
      const before = project.exists(path) ? project.read(path) : null;
      working.set(path, { before, text: before ?? '' });
      order.push(path);
    }
    const file = working.get(path)!;
    if (spec.old_string === '') {
      if (file.before !== null || file.text !== '') throw new Error(`old_string is empty but ${path} already exists. Copy the exact text you want to replace.`);
      file.text = spec.new_string;
      continue;
    }
    const n = count(file.text, spec.old_string);
    if (n === 0) throw new Error(`old_string was not found in ${path}. Re-read the file and copy the exact current text, including whitespace.`);
    if (n > 1) throw new Error(`old_string appears ${n} times in ${path}. Include more surrounding lines so it matches exactly once.`);
    file.text = file.text.replace(spec.old_string, () => spec.new_string);
  }
  return order.map((path) => {
    const f = working.get(path)!;
    return { path, before: f.before, after: f.text };
  });
}
