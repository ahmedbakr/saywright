/**
 * Starting another program, by name or by path, the same way on every system. On Windows, what npm installs (claude,
 * codex, gemini, npx, an editor's `code`) is a .cmd file, which Node refuses to start without a shell since its April
 * 2024 security release (CVE-2024-27980). cross-spawn starts such a file through cmd.exe with every argument escaped,
 * and anything else (and everything on macOS and Linux) as Node's own spawn does.
 *
 * An app npm installed is better started without cmd.exe at all: its .cmd file hands its arguments to a script with
 * `%*`, which has cmd.exe read them a second time, so JSON (an MCP configuration, a schema) or a path with `&` in it
 * could change on the way. Its script is run with Node instead, and gets its arguments exactly as given.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';

export function spawnProgram(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const node = process.platform === 'win32' ? viaNode(command) : null;
  return node ? spawn(node.exe, [node.script, ...args], options) : crossSpawn(command, [...args], options);
}

export function spawnProgramSync(command: string, args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  const node = process.platform === 'win32' ? viaNode(command) : null;
  return node ? spawnSync(node.exe, [node.script, ...args], options) : crossSpawn.sync(command, [...args], options);
}

/**
 * Whether a command names a file: a path, or a name on PATH (with PATHEXT's endings on Windows). On Windows a missing
 * program goes through cmd.exe, which starts, so its start can't say it is missing; this can.
 */
export function programExists(command: string, env: NodeJS.ProcessEnv = process.env, win = process.platform === 'win32'): boolean {
  const endings = win ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const file = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const found = (base: string) => endings.some((e) => file(base + e));
  // A path set in quotes, as Windows writes paths with spaces ("C:\Program Files\…\Code.exe").
  const name = command.replace(/^"(.+)"$/, '$1');
  if (path.isAbsolute(name) || /[\\/]/.test(name)) return found(path.resolve(name));
  return (env.PATH ?? env.Path ?? '').split(path.delimiter).some((dir) => !!dir && found(path.join(dir, name)));
}

/**
 * The script an npm-installed app's .cmd file runs with Node, read from the file (npm writes them all alike, ending in
 * `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`, or `"%~dp0\…" %*` in older versions), or null for any other
 * .cmd file. Windows paths, wherever this runs.
 */
export function npmShimScript(cmdFile: string, text: string): string | null {
  if (!/IF EXIST "%~?dp0%?\\node\.exe"/i.test(text)) return null;
  const m = /"%~?dp0%?\\([^"%]+)"\s+%\*\s*$/im.exec(text);
  return m ? path.win32.join(path.win32.dirname(cmdFile), m[1]) : null;
}

/** An npm-installed app given by its .cmd file: the Node to run its script with (its own, if npm put one beside it), and the script. */
function viaNode(command: string): { exe: string; script: string } | null {
  if (!path.isAbsolute(command) || !/\.cmd$/i.test(command)) return null;
  let text: string;
  try {
    text = fs.readFileSync(command, 'utf8');
  } catch {
    return null;
  }
  const script = npmShimScript(command, text);
  if (!script || !fs.existsSync(script)) return null;
  const own = path.join(path.dirname(command), 'node.exe');
  return { exe: fs.existsSync(own) ? own : process.execPath, script };
}

/** Run a program briefly, without a shell of its own; resolves even when it fails, with what it printed (1 MB at most). */
export function runQuiet(command: string, args: string[], timeoutMs = 6000, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawnProgram(command, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      return resolve({ code: null, stdout, stderr });
    }
    const keep = (text: string, more: Buffer) => (text.length < 1 << 20 ? text + more.toString() : text);
    child.stdout!.on('data', (d: Buffer) => (stdout = keep(stdout, d)));
    child.stderr!.on('data', (d: Buffer) => (stderr = keep(stderr, d)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
