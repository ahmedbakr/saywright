/**
 * The project operations Claude can use, plus validation of proposed edits.
 * Paths always go through Project.resolve, which refuses anything outside the
 * project, node_modules, .git and env files.
 */
import type { FileEdit } from '../changes.ts';
import type { Coverage } from '../code-index.ts';
import type { Project } from '../project.ts';
import { maskCode, unmaskCode } from './secrets.ts';
import { eolOf, isBinaryName, lfView, toLf, unwritable, withEol, type TextEncoding } from '../text-file.ts';

const MAX_READ_LINES = 400;

/** What a model is told about a file that isn't UTF-8, wherever it is shown one: what it may write there. */
export const LATIN1_NOTE = 'not UTF-8: read as Latin-1, so only characters up to U+00FF can be written in it';

export function readFileTool(project: Project, path: string, start?: number, end?: number): string {
  const file = project.readText(path);
  // Line ends as LF, whatever the file has: an edit is matched the same way.
  const lines = toLf(file.text).split('\n');
  const s = Math.max(1, Math.floor(start ?? 1));
  const e = Math.min(lines.length, Math.floor(end ?? s + MAX_READ_LINES - 1), s + MAX_READ_LINES - 1);
  if (s > lines.length) return `${path} has only ${lines.length} lines.`;
  // Keys written in the code go out as placeholders (see secrets.ts); an edit that quotes one gets the value back.
  const body = lines
    .slice(s - 1, e)
    .map((l, i) => `${String(s + i).padStart(4)}  ${maskCode(project, l)}`)
    .join('\n');
  const more = e < lines.length ? `\n… ${lines.length - e} more lines. Call read_file with start_line=${e + 1} to continue.` : '';
  return `${path} (lines ${s}-${e} of ${lines.length}${file.encoding === 'latin1' ? `; ${LATIN1_NOTE}` : ''})\n${body}${more}`;
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
  const lines = r.hits.map((h) => `${h.path}:${h.line}: ${maskCode(project, h.text)}`);
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

/** A file a change is being made in: as it was, as it is after the edits so far, and how it is written. */
interface Working {
  path: string;
  before: string | null;
  text: string;
  encoding: TextEncoding;
  eol: '\r\n' | '\n';
}

/**
 * Turn exact-string edits into full before/after file contents. Throws an
 * Error whose message tells Claude precisely what to fix, so it can retry.
 *
 * A file keeps what it is: an edit is matched with line ends left aside (the model reads and writes LF) and what it
 * adds takes the line ends the file has, every other line's end is left as it was, and a file that isn't UTF-8 only
 * takes the characters its encoding can hold.
 */
export function applyEditSpecs(project: Project, specs: EditSpec[]): FileEdit[] {
  if (!specs.length) throw new Error('No edits were given.');
  if (specs.length > 25) throw new Error('Too many edits in one change; keep it focused.');
  // By the file each path leads to, so one file written two ways (“a.js”, “x/../a.js”) is edited once, in order.
  const working = new Map<string, Working>();
  for (const raw of specs) {
    // A key the model was shown as a placeholder is written back as it was.
    const spec = { ...raw, old_string: typeof raw.old_string === 'string' ? unmaskCode(project, raw.old_string) : raw.old_string, new_string: typeof raw.new_string === 'string' ? unmaskCode(project, raw.new_string) : raw.new_string };
    const path = spec.path.replace(/^\.\//, '');
    const abs = project.resolve(path); // throws on unsafe paths
    let file = working.get(abs);
    if (!file) {
      if (isBinaryName(path)) throw new Error(`${path} is a binary file by its name: only text files can be read or written here.`);
      const read = project.exists(path) ? project.readText(path) : null;
      file = { path, before: read?.text ?? null, text: read?.text ?? '', encoding: read?.encoding ?? 'utf8', eol: read ? eolOf(read.text) : '\n' };
      working.set(abs, file);
    }
    const bad = unwritable(spec.new_string, file.encoding);
    if (bad) {
      throw new Error(
        `${file.path} isn’t saved as UTF-8 (it is read as Latin-1), and new_string has a character it can’t hold: “${bad}” (U+${bad.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}). Write only characters up to U+00FF in this file (an HTML entity or an escape may do), or tell the user the file must be saved as UTF-8 first.`,
      );
    }
    if (spec.old_string === '') {
      if (file.before !== null || file.text !== '') throw new Error(`old_string is empty but ${file.path} already exists. Copy the exact text you want to replace.`);
      file.text = spec.new_string;
      continue;
    }
    const view = lfView(file.text);
    const old = toLf(spec.old_string);
    const n = count(view.lf, old);
    if (n === 0) throw new Error(`old_string was not found in ${file.path}. Re-read the file and copy the exact current text, including whitespace.`);
    if (n > 1) throw new Error(`old_string appears ${n} times in ${file.path}. Include more surrounding lines so it matches exactly once.`);
    const at = view.lf.indexOf(old);
    file.text = file.text.slice(0, view.at(at)) + withEol(spec.new_string, file.eol) + file.text.slice(view.at(at + old.length));
  }
  return [...working.values()].map((f) => ({ path: f.path, before: f.before, after: f.text }));
}
