/**
 * Open in editor (O in the studio): the file and line of what you point at, in your code editor. The editor is found
 * as Vite's dev server finds it (launch-editor): LAUNCH_EDITOR, else an editor that is running, else VISUAL or EDITOR.
 * It is started without a shell (on Windows, an editor's .cmd through cmd.exe with its arguments escaped), only for a
 * file of the open app, and only when the studio's own page asks.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import getArgs from 'launch-editor/get-args.js';
import guess from 'launch-editor/guess.js';
import { HttpError, sendJson } from './http.ts';
import { programExists, spawnProgram } from './program.ts';
import type { Project } from './project.ts';

/** An editor among the programs running, found in their list as launch-editor reads it on each system. */
function runningEditor(): string | undefined {
  const list = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true });
  try {
    if (process.platform === 'darwin') return guess.getEditorFromMacProcesses(list('ps', ['x', '-o', 'comm=']));
    if (process.platform === 'linux') return guess.getEditorFromLinuxProcesses(list('ps', ['x', '--no-heading', '-o', 'comm', '--sort=comm']));
    if (process.platform === 'win32') {
      const query = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-CimInstance -Query "select executablepath from win32_process where executablepath is not null" | % { $_.ExecutablePath }';
      return guess.getEditorFromWindowsProcesses(list('powershell', ['-NoProfile', '-Command', query]));
    }
  } catch {
    /* no list of programs: the variables below */
  }
  return undefined;
}

/** The editor files open in; null when there is none. */
function findEditor(): string | null {
  return process.env.LAUNCH_EDITOR || runningEditor() || process.env.VISUAL || process.env.EDITOR || null;
}

/** An editor in the terminal takes the studio's: a second one replaces the first, as launch-editor does. */
const IN_TERMINAL = /^(vim|emacs|nano)$/;
let inTerminal: ChildProcess | null = null;

/** Start the editor at that place in the file. Resolves with its command once it has started. */
function launch(file: string, line: number, col: number): Promise<string> {
  const editor = findEditor();
  if (!editor) return Promise.reject(new HttpError(409, 'Couldn’t find your code editor. Open it, or set LAUNCH_EDITOR to its command (such as code), and try again.', 'no-editor'));
  const failed = (why: string) => new HttpError(409, `Couldn’t start ${path.basename(editor)} (${why}). Set LAUNCH_EDITOR to your editor’s command (such as code), and try again.`, 'no-editor');
  // Elsewhere a missing editor fails to start; on Windows it would go through cmd.exe, which starts.
  if (process.platform === 'win32' && !programExists(editor)) return Promise.reject(failed('no such command'));
  const terminal = IN_TERMINAL.test(path.basename(editor));
  if (terminal) inTerminal?.kill('SIGKILL');
  return new Promise((resolve, reject) => {
    const child = spawnProgram(editor, getArgs(editor, file, String(line), String(col)), { stdio: 'inherit', windowsHide: true });
    child.once('spawn', () => resolve(editor));
    child.once('error', (err: NodeJS.ErrnoException) => reject(failed(err.code === 'ENOENT' ? 'no such command' : err.message)));
    if (!terminal) return;
    inTerminal = child;
    child.once('exit', () => {
      if (inTerminal === child) inTerminal = null;
    });
  });
}

/** A request from the studio's own page, or not from a web page at all: a browser names the page on every POST. */
function fromStudio(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** POST /__open-in-editor?file=<path>:<line>:<column>, for a file of the open app (`project`). */
export function editorRoute(project: () => Project | null) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'Use POST.');
      }
      if (!fromStudio(req)) throw new HttpError(403, 'Only the studio can open files in your editor.');
      // Under Vite the route is cut from req.url; the query stays.
      const at = /^(.+?)(?::(\d+))?(?::(\d+))?$/.exec(new URL(req.url ?? '/', 'http://localhost').searchParams.get('file') ?? '');
      if (!at) throw new HttpError(400, 'Which file? Give ?file=<path>:<line>:<column>.');
      const app = project();
      if (!app) throw new HttpError(409, 'Open an app first.', 'no-app');
      const file = app.resolve(at[1]);
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, `No such file: ${app.rel(file)}`);
      const editor = await launch(file, Number(at[2] ?? 1), Number(at[3] ?? 1));
      sendJson(res, 200, { ok: true, editor: path.basename(editor) });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, code: err.code });
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
