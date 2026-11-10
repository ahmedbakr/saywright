/**
 * Dev servers the studio starts for linked apps: the app's own command (npm
 * run dev…) in its folder, or a small static server for a folder of HTML. The
 * address the server says it listens on is read from its output, since ports
 * move when one is taken. Output is kept (last lines) for the app list.
 *
 * What it starts, the studio stops: the whole process group, and a server the
 * command moved to the background (it says where and its pid) too. The groups
 * are written down in the data folder while they run (started.ts), so what a
 * studio that ended without stopping them left is stopped by the next one.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import type { AppRun, LinkedApp, RunStatus } from '../../shared/apps.ts';
import { sendFile } from '../streams.ts';
import { ended, started } from './started.ts';

const MAX_LOG = 300;
// oxlint-disable-next-line no-control-regex -- the escape character starts the terminal's colour and title codes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const URL_IN = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s'"]*)?)/;
/** "Local:   http://…" (Vite, Next.js), "┃ Local    http://…" (Astro): the server's own address. */
const LOCAL_LINE = /\blocal\b\s*:?\s+https?:\/\//i;
/** "Dev server running at http://localhost:4321 (pid 1234)": a server moved to the background (astro dev --background). */
const BACKGROUND = /\brunning at https?:\/\/\S+ \(pid (\d+)\)/i;
/**
 * How long its output must stay quiet before an address it printed without a "Local" line is taken: a command that
 * runs several servers (its API, then its web server) prints the API's address first and the "Local" line later.
 */
const QUIET_MS = 3000;

/** Quiet, non-interactive dev servers: no browser opening, no telemetry prompts. */
const CHILD_ENV = {
  BROWSER: 'none',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  NEXT_TELEMETRY_DISABLED: '1',
  ASTRO_TELEMETRY_DISABLED: '1',
  // Astro moves its dev server to the background when an AI agent seems to run it (the studio may have been
  // started by one): this says it already is the server, so it stays in this process group, where Stop reaches it.
  ASTRO_DEV_BACKGROUND: '1',
  GATSBY_TELEMETRY_DISABLED: '1',
  NG_CLI_ANALYTICS: 'false',
  NUXT_TELEMETRY_DISABLED: '1',
};

/** A local address a dev server printed, and whether it was on its "Local" line (or one saying where it moved). */
export interface Seen {
  url: string;
  local: boolean;
}

interface Run extends AppRun {
  proc: ChildProcess | null;
  server: http.Server | null;
  /** The addresses it printed, in order. */
  seen: Seen[];
  /** The end of its output that isn't a whole line yet (an address can be cut in two). */
  partial: string;
  /** When it last printed something. */
  printedAt: number;
  /** The pid of a server the command said it moved to the background; `adopted` once the command has exited. */
  background: number | null;
  adopted: number | null;
  watch: ReturnType<typeof setInterval> | null;
}

/** The local addresses in a dev server's output, in order, each marked when it is on the "Local" line. */
export function addressesIn(text: string): Seen[] {
  const out: Seen[] = [];
  for (const line of text.replace(ANSI, '').split(/\r?\n/)) {
    const m = URL_IN.exec(line);
    if (!m || /\bnetwork\b/i.test(line)) continue;
    const url = m[1].replace('0.0.0.0', 'localhost').replace(/[).,]+$/, '');
    const local = LOCAL_LINE.test(line) || BACKGROUND.test(line);
    const known = out.find((s) => s.url === url);
    if (!known) out.push({ url, local });
    else known.local ||= local;
  }
  return out;
}

/**
 * Where a dev server listens, from the addresses it printed: its "Local" one, else the first bare address. One with a
 * path elsewhere is a plugin's endpoint (/__mcp/sse, /__inspect/), often printed first and on the old port.
 */
export function pickUrl(seen: Seen[]): string | null {
  return seen.find((s) => s.local)?.url ?? seen.find((s) => new URL(s.url).pathname === '/')?.url ?? null;
}

/** The address a dev server printed (see pickUrl). */
export const urlFromOutput = (text: string): string | null => pickUrl(addressesIn(text));

/**
 * How a dev server answers at `url` within `ms`: its status, or `busy` when it took the request but hasn't answered yet
 * (a first page can take long to compile), or `down`. A local dev server's own certificate is fine here.
 */
function check(url: string, ms: number): Promise<number | 'busy' | 'down'> {
  return answer(url, ms).then((a) => (typeof a === 'string' ? a : a.status));
}

/** The same, and whether what answered is a page (not an error, not JSON or a script: an API, a tool). */
function answer(url: string, ms: number): Promise<{ status: number; page: boolean } | 'busy' | 'down'> {
  return new Promise((resolve) => {
    let connected = false;
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: ms, rejectUnauthorized: false, headers: { accept: 'text/html' } }, (res) => {
      res.resume();
      const status = res.statusCode ?? 500;
      const type = String(res.headers['content-type'] ?? '');
      resolve({ status, page: status < 400 && (!type || /html/i.test(type)) });
    });
    req.on('socket', (socket) => socket.once('connect', () => (connected = true)));
    const gone = () => resolve(connected ? 'busy' : 'down');
    req.on('timeout', () => {
      gone();
      req.destroy();
    });
    req.on('error', gone);
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('No free port');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Whether a page says its encoding itself, where the browser looks for it: a byte order mark, or <meta> in its first 1024 bytes. */
function ownCharset(file: string): boolean {
  const head = Buffer.alloc(1024);
  let n = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      n = fs.readSync(fd, head, 0, 1024, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const bytes = head.subarray(0, n);
  if ((bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  return /<meta\b[^>]*charset\s*=/i.test(bytes.toString('latin1'));
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * A folder of HTML served as is (no build step), to this computer only: a
 * page elsewhere that points a name at 127.0.0.1 (DNS rebinding) is refused,
 * and so are hidden files and folders (.env, .git, the studio's own
 * .saywright with its recordings) and links that lead out of the folder.
 */
function staticServer(root: string): http.Server {
  const base = fs.realpathSync(root);
  const inside = (p: string) => p === base || p.startsWith(base + path.sep);
  return http.createServer((req, res) => {
    const deny = (status: number, text: string) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(text);
    };
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return deny(421, 'This server answers on localhost only.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'Method not allowed');
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return deny(400, 'Bad address');
    }
    const parts = path.normalize(rel).split(/[/\\]+/).filter(Boolean);
    if (parts.some((p) => p.startsWith('.') && p !== '.well-known')) return deny(404, 'Not found');
    let file = path.join(base, ...parts);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && !path.extname(file)) file += '.html';
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return deny(404, 'Not found');
    }
    if (!inside(real) || !fs.statSync(real).isFile()) return deny(404, 'Not found');
    const ext = path.extname(real).toLowerCase();
    // A page that names its own encoding (<meta charset>, a byte order mark) keeps it: the header would override it.
    const own = (ext === '.html' || ext === '.htm') && ownCharset(real);
    res.setHeader('Content-Type', own ? 'text/html' : (MIME[ext] ?? 'application/octet-stream'));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') return res.end();
    sendFile(real, res);
  });
}

export class AppRunner {
  private runs = new Map<string, Run>();
  private flush = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param moved told when a running app says it listens elsewhere than where the studio found it (its "Local" line
   * came later, or it restarted on another port).
   */
  constructor(
    private emit: (run: AppRun) => void,
    private moved?: (id: string, url: string) => void,
  ) {}

  private view(r: Run): AppRun {
    return { app: r.app, status: r.status, command: r.command, url: r.url, startedAt: r.startedAt, exitCode: r.exitCode, log: r.log.slice(-60) };
  }

  get(id: string): AppRun {
    const r = this.runs.get(id);
    return r ? this.view(r) : { app: id, status: 'stopped', command: null, url: null, startedAt: null, exitCode: null, log: [] };
  }

  all(): AppRun[] {
    return [...this.runs.values()].map((r) => this.view(r));
  }

  running(id: string): boolean {
    const s = this.runs.get(id)?.status;
    return s === 'starting' || s === 'running' || s === 'installing';
  }

  private run(id: string): Run {
    let r = this.runs.get(id);
    if (!r) {
      r = { app: id, status: 'stopped', command: null, url: null, startedAt: null, exitCode: null, log: [], proc: null, server: null, seen: [], partial: '', printedAt: 0, background: null, adopted: null, watch: null };
      this.runs.set(id, r);
    }
    return r;
  }

  /** A line of the studio's own in the app's notes (its log in the app list). */
  note(id: string, text: string): void {
    this.append(this.run(id), `${text}\n`);
  }

  private set(r: Run, status: RunStatus): void {
    r.status = status;
    this.emit(this.view(r));
  }

  /** Output lines, sent to the studio a few times a second at most. */
  private append(r: Run, chunk: string): void {
    const text = chunk.replace(ANSI, '');
    r.printedAt = Date.now();
    const whole = (r.partial + text).split(/\r?\n/);
    r.partial = whole.pop() ?? '';
    this.read(r, whole);
    const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (!lines.length) return;
    r.log.push(...lines.map((l) => l.slice(0, 400)));
    if (r.log.length > MAX_LOG) r.log.splice(0, r.log.length - MAX_LOG);
    if (!this.flush.has(r.app)) {
      this.flush.set(
        r.app,
        setTimeout(() => {
          this.flush.delete(r.app);
          this.emit(this.view(r));
        }, 250),
      );
    }
  }

  /** What whole lines of output say: the addresses it listens at, and a server it moved to the background. */
  private read(r: Run, lines: string[]): void {
    for (const seen of addressesIn(lines.join('\n'))) {
      const known = r.seen.find((s) => s.url === seen.url);
      if (!known) r.seen.push(seen);
      else if (seen.local && !known.local) known.local = true;
      else continue;
      // Running already: a "Local" line it prints now is where it is (it came after another address, or it restarted).
      if (r.status === 'running' && seen.local && seen.url !== r.url && r.proc) {
        r.url = seen.url;
        this.append(r, `It says it listens at ${seen.url}: the studio uses that address now.\n`);
        this.emit(this.view(r));
        this.moved?.(r.app, seen.url);
      }
    }
    if (r.status !== 'running') r.url = pickUrl(r.seen) ?? r.url;
    for (const line of lines) {
      const bg = BACKGROUND.exec(line);
      if (bg) r.background = Number(bg[1]);
    }
  }

  private spawn(r: Run, command: string, cwd: string): ChildProcess {
    const proc = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, ...CHILD_ENV } });
    proc.stdout?.on('data', (d: Buffer) => this.append(r, d.toString()));
    proc.stderr?.on('data', (d: Buffer) => this.append(r, d.toString()));
    // Written down in the data folder until the group is gone, so a studio that ends without stopping it (its
    // terminal closed, a crash) has the next one stop it (started.ts).
    const pid = proc.pid;
    if (process.platform !== 'win32') {
      started(pid, command, cwd);
      proc.on('exit', () => {
        if (pid && !treeAlive(pid)) ended(pid);
      });
    }
    return proc;
  }

  /** Install the app's dependencies (its own package manager). Resolves with whether it worked. */
  install(app: LinkedApp): Promise<boolean> {
    if (!app.root) return Promise.resolve(false);
    const r = this.run(app.id);
    const pm = app.packageManager ?? 'npm';
    r.command = `${pm} install`;
    r.log = [`$ ${pm} install`];
    r.exitCode = null;
    this.set(r, 'installing');
    return new Promise((resolve) => {
      const proc = this.spawn(r, `${pm} install`, app.root!);
      r.proc = proc;
      proc.on('error', (err) => {
        this.append(r, `${err.message}\n`);
      });
      proc.on('exit', (code) => {
        r.proc = null;
        r.exitCode = code;
        this.set(r, code === 0 ? 'stopped' : 'crashed');
        resolve(code === 0);
      });
    });
  }

  /** Start the app's dev server, unless it is running already. */
  async start(app: LinkedApp): Promise<AppRun> {
    const r = this.run(app.id);
    if (r.status === 'running' || r.status === 'starting') return this.view(r);
    if (!app.root) throw new Error('This app has no folder on this computer to start.');
    Object.assign(r, { url: null, exitCode: null, startedAt: Date.now(), seen: [], partial: '', printedAt: Date.now(), background: null });
    if (app.framework === 'static' && !app.start) {
      const port = await freePort(5300);
      const server = staticServer(app.root);
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
      r.server = server;
      r.command = 'built-in static server';
      r.url = `http://localhost:${port}`;
      r.log = [`Serving ${app.root} at ${r.url}`];
      this.set(r, 'running');
      return this.view(r);
    }
    if (!app.start) throw new Error('Tell the studio how to start this app (its dev command), or start it yourself.');
    r.command = app.start;
    r.log = [`$ ${app.start}`];
    this.set(r, 'starting');
    const proc = this.spawn(r, app.start, app.root);
    r.proc = proc;
    proc.on('error', (err) => this.append(r, `${err.message}\n`));
    proc.on('exit', (code, signal) => {
      if (r.proc !== proc) return;
      r.proc = null;
      r.exitCode = code;
      this.read(r, [r.partial]);
      r.partial = '';
      if (code === 0 && r.status !== 'stopped' && r.background && alive(r.background)) return this.adopt(r, r.background);
      this.append(r, signal ? `Stopped (${signal}).\n` : `Exited with code ${code}.\n`);
      this.set(r, r.status === 'stopped' ? 'stopped' : code === 0 || signal === 'SIGTERM' ? 'stopped' : 'crashed');
    });
    return this.view(r);
  }

  /** The command moved its server to the background and exited: that server is the app's from now on. */
  private adopt(r: Run, pid: number): void {
    r.adopted = pid;
    this.append(r, `It moved its server to the background (pid ${pid}). The studio stops it when you stop the app.\n`);
    r.watch = setInterval(() => {
      if (alive(pid)) return;
      this.unwatch(r);
      this.append(r, 'Its server stopped.\n');
      if (r.status !== 'stopped') this.set(r, 'stopped');
    }, 1000);
    r.watch.unref();
  }

  private unwatch(r: Run): void {
    if (r.watch) clearInterval(r.watch);
    r.watch = null;
    r.adopted = null;
  }

  /**
   * Mark it running once its address answers. Its "Local" address (any answer, an error page too, and it gets time to
   * compile its first page) wins. Without one, `fallbackUrl`, where it usually runs, counts when it answers; and an
   * address it printed counts only once its output has gone quiet (its web server's "Local" line may come after its
   * API's address) and only when it answers with a page: an API's 404 or JSON is never taken for the app. When time is
   * up, every other address it printed is tried. Resolves with where it is, or null: it stopped, or nothing answered
   * (it is still running then).
   */
  async ready(id: string, fallbackUrl: string | null, ms = 90_000): Promise<string | null> {
    const r = this.runs.get(id);
    if (!r) return null;
    const started = r.startedAt;
    // This start, still going: a stop or a crash that comes while an address is being asked wins.
    const going = () => this.runs.get(id) === r && r.startedAt === started && (r.status === 'starting' || r.status === 'running');
    const answered = (url: string) => {
      if (!going()) return null;
      r.url = url;
      if (r.status !== 'running') this.set(r, 'running');
      return url;
    };
    // The studio's own static server: it is where the studio put it.
    if (r.server && r.url) return answered(r.url);
    // An address it printed without a "Local" line, once nothing more is coming for now.
    const settled = () => Date.now() - r.printedAt >= QUIET_MS || !r.proc;
    const isPage = (a: Awaited<ReturnType<typeof answer>>) => typeof a === 'object' && a.page;
    const until = Date.now() + ms;
    let busy: string | null = null;
    while (Date.now() < until) {
      if (!going()) return null;
      const local = r.seen.find((s) => s.local)?.url;
      if (local) {
        const state = await check(local, Math.max(2500, Math.min(30_000, until - Date.now())));
        if (typeof state === 'number') return answered(local);
        busy = state === 'busy' ? local : null;
      } else {
        if (fallbackUrl) {
          const state = await check(fallbackUrl, 2500);
          if (typeof state === 'number' && state < 500) return answered(fallbackUrl);
        }
        const printed = pickUrl(r.seen);
        if (printed && settled() && going() && isPage(await answer(printed, 2500))) return answered(printed);
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    // Time is up: whatever else it printed may be it (a plugin's endpoint on the port it uses, without a "Local" line).
    const tried = new Set([busy, fallbackUrl]);
    for (const s of r.seen) {
      const url = s.local || new URL(s.url).pathname === '/' ? s.url : new URL(s.url).origin;
      if (tried.has(url)) continue;
      tried.add(url);
      if (!going()) return null;
      const state = await answer(url, 2500);
      if (s.local ? typeof state === 'object' : isPage(state)) return answered(url);
    }
    if (busy) this.append(r, 'It is still working on its first page: the studio shows it as it comes.\n');
    return busy ? answered(busy) : null;
  }

  async stop(id: string): Promise<void> {
    const r = this.runs.get(id);
    if (!r) return;
    const proc = r.proc;
    const adopted = r.adopted;
    r.status = 'stopped';
    this.unwatch(r);
    if (r.server) {
      const server = r.server;
      r.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The command with everything it started (its process group), and a server it moved to the background: asked to
    // stop, then made to after 4 seconds. The shell can end before the server it ran, so the whole group is waited for.
    for (const pid of [proc?.exitCode === null ? proc.pid : undefined, adopted]) {
      if (!pid) continue;
      killTree(pid, 'SIGTERM');
      for (const end = Date.now() + 4000; Date.now() < end && treeAlive(pid); ) await new Promise((res) => setTimeout(res, 100));
      if (treeAlive(pid)) killTree(pid, 'SIGKILL');
      ended(pid);
    }
    r.proc = null;
    this.emit(this.view(r));
  }

  /** Stop everything the studio started (when it closes). */
  stopAll(): void {
    for (const r of this.runs.values()) {
      if (r.proc?.pid && r.proc.exitCode === null) killTree(r.proc.pid, 'SIGTERM');
      if (r.adopted) killTree(r.adopted, 'SIGTERM');
      this.unwatch(r);
      r.server?.close();
    }
  }
}

/** Whether a process, or anything left in the process group it leads, is still there. */
function treeAlive(pid: number): boolean {
  if (process.platform === 'win32') return alive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return alive(pid);
  }
}

/** A process and everything it started: dev commands start children (npm → node → esbuild…) in their own group. */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}
