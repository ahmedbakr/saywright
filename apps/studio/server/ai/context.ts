import { maskSecrets, parseSrc, redactUrl } from '@saywright/vite/protocol';
import type { Project } from '../project.ts';
import { toLf } from '../text-file.ts';
import { maskCode } from './secrets.ts';
import { LATIN1_NOTE } from './tools.ts';
import type { AgentInput } from './types.ts';

const FULL_FILE_LINES = 400;
const WINDOW = 80;
/** The most code the first message carries, in characters, whatever the line count: about 30,000 tokens. */
const MAX_CONTEXT_CHARS = 120_000;
/** A line longer than this is cut, with a marker (an inlined SVG, a data URL). */
const MAX_LINE_CHARS = 400;
/** A file whose lines average more than this is minified or data: it is left out, with a note. */
const MINIFIED_AVG = 300;

/** Stable across requests (it only changes when project files or the design system change), so it caches well. */
export function systemPrompt(project: Project): string {
  const config = project.config;
  const components = Object.entries(config.components)
    .map(([name, spec]) => {
      const props = Object.entries(spec.props)
        .map(([p, d]) => `${p}: ${d.values.join(' | ')}${d.default ? ` (default ${d.default})` : ''}`)
        .join('; ');
      return `- ${name}${spec.file ? ` (${spec.file})` : ''}: ${props || 'no tracked props'}`;
    })
    .join('\n');
  const files = project.listFiles('', 300);

  return `You are the coding agent inside Saywright. A developer points at their running web app with a hand, their voice or a mouse and says or types what they want. You turn each request into a small, correct code change, or answer a question about the code.

How requests arrive
- "Said" is the user's words. It is often transcribed from speech, so expect filler words and small recognition errors.
- "this" and "that" were resolved to the exact elements the user pointed at. For each one you get its component name, visible text and where it was written (file:line:column of its JSX, template or HTML), and the code around it.
- A location marked as a guess was found by searching the code for the element's text, not reported by the app: check that it is the element before changing it there, and look further if it isn't.

How to work
- Make the smallest change that does what was asked, in the code's existing style.
- When the design system covers it, change UI through its components and props, using only the values it defines. Never invent colors, sizes or pixel values. If a request needs a value the design system doesn't have, say so in one sentence instead of inventing it.
- For wrong numbers or behavior, find the real cause, which may be in a different file from the element, and fix it there.
- Use read_file, search_code and list_files only when the provided context is not enough.
- When you have the change, call propose_change once with every edit. Each old_string must be copied exactly from the current file and match exactly once; include a line or two of context to make it unique. The user sees your change as a live preview and keeps or undoes it.
- If the user asked a question (why, what, where, how), answer it in plain text. Don't change code unless they asked for a change.
- Every plain-text answer, whether to a question, to a request that is already done or needs nothing, or to one you won't do, is at most four short sentences in one paragraph: no lists, headings or bold. Cite files as path:line; name several places in one sentence when they all matter.
- If the request is ambiguous, ask one short question instead of guessing.

Project: ${project.name}
${config.guidelines ? `Guidelines: ${config.guidelines}\n` : ''}${components ? `Design-system components (from the studio config):\n${components}\n` : ''}
Files:
${files.join('\n')}`;
}

function numbered(project: Project, lines: string[], start: number, end: number): string {
  return lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(4)}  ${maskCode(project, l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} … (line cut: ${l.length.toLocaleString('en-US')} characters)` : l)}`)
    .join('\n');
}

/** Ranges that overlap or touch, joined; the rest kept apart (two places far apart in a long file are two windows). */
function merged(ranges: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Per-request message: what was said, what was pointed at, and the code around it. */
export function userMessage(input: AgentInput, project: Project): string {
  const parts: string[] = [];
  parts.push(`Said: "${input.text.trim()}"`);
  // The page's address and what elements show, as anything sent to an AI: a token in the address or a key on screen masked.
  if (input.pageUrl) parts.push(`Page: ${redactUrl(input.pageUrl)}`);

  if (input.refs.length) {
    parts.push('\nReferenced elements:');
    input.refs.forEach((r, i) => {
      const text = r.text ? ` showing “${maskSecrets(r.text).slice(0, 60)}”` : '';
      parts.push(`${i + 1}. ${r.role} → ${r.name}${text}${r.src ? ` at ${r.src}${r.guessed ? ' (a guess, found by searching the code for its text)' : ''}` : ' (not mapped to source)'}`);
    });
  } else {
    parts.push('\nThe user did not point at anything; work out the target from their words.');
  }

  // Source context: whole files when small, otherwise a window around each location.
  const windows = new Map<string, Array<[number, number]>>();
  for (const r of input.refs) {
    const p = r.src ? parseSrc(r.src) : null;
    if (!p || !project.exists(p.file)) continue;
    const list = windows.get(p.file) ?? [];
    list.push([p.line - WINDOW, p.line + WINDOW]);
    windows.set(p.file, list);
  }
  let room = MAX_CONTEXT_CHARS;
  for (const [file, ranges] of windows) {
    let read: ReturnType<Project['readText']>;
    try {
      read = project.readText(file);
    } catch (err) {
      // A binary file, or one the AI may not read: named, not sent.
      parts.push(`\n--- ${file}: not included (${err instanceof Error ? err.message : String(err)}) ---`);
      continue;
    }
    // As read_file shows it: line ends as LF, and what may be written in a file that isn't UTF-8.
    const lines = toLf(read.text).split('\n');
    const note = read.encoding === 'latin1' ? `; ${LATIN1_NOTE}` : '';
    if (read.text.length / lines.length > MINIFIED_AVG) {
      parts.push(`\n--- ${file}: not included (minified or data: ${read.text.length.toLocaleString('en-US')} characters on ${lines.length} line${lines.length === 1 ? '' : 's'}; read_file or search_code for a part of it) ---`);
      continue;
    }
    if (room <= 0) {
      parts.push(`\n--- ${file}: not included (the code sent with a request is capped; read_file for it) ---`);
      continue;
    }
    const blocks: string[] = [];
    if (lines.length <= FULL_FILE_LINES) blocks.push(`\n--- ${file} (all ${lines.length} lines${note}) ---\n${numbered(project, lines, 1, lines.length)}`);
    else
      for (const [a, b] of merged(ranges)) {
        const start = Math.max(1, a);
        const end = Math.min(lines.length, b);
        blocks.push(`\n--- ${file} (lines ${start}-${end} of ${lines.length}; read_file for more${note}) ---\n${numbered(project, lines, start, end)}`);
      }
    for (const b of blocks) {
      if (b.length > room) {
        parts.push(`${b.slice(0, Math.max(0, room))}\n… (cut: the code sent with a request is capped; read_file for the rest)`);
        room = 0;
        break;
      }
      parts.push(b);
      room -= b.length;
    }
  }

  if (input.brief) {
    parts.push(
      `\nFrom a test session's report (the tester chose these, with the evidence the studio recorded):`,
      input.brief,
      `\nHandle them together: one propose_change with every edit. Fix the real cause of each, which may be away from where it showed. Leave out any you can't confirm in the code, and say which in the summary.`,
    );
  }

  if (input.mode === 'fix' && input.test) {
    parts.push(
      `\nThe user narrated a bug while using the app, and Saywright turned it into this Playwright test. It fails.`,
      `--- ${input.test.path} ---\n${input.test.code}`,
      `Failure:\n${input.test.failure}`,
      `\nFind the root cause in the app code and fix it with propose_change. Don't edit the test unless it is clearly wrong.`,
    );
  }
  return parts.join('\n');
}
