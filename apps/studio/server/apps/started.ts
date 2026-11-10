/**
 * The process groups of the dev servers the studio starts, written down in its data folder (started.json) while they
 * run. A studio that ends without stopping them (its terminal closed, a crash, a kill) leaves them listed; the next
 * studio stops those still alive and still what was started, the same command in the same folder, before it trusts
 * whatever answers at their ports. A group that no longer looks like that is only forgotten: nothing the studio
 * didn't start is ever signalled. Not on Windows, where a dev server has no process group to find again.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface Entry {
  /** The group's id: the pid of the shell the command was started in. */
  pgid: number;
  command: string;
  cwd: string;
  /** The studio that started it: while that one runs, the group is its own. */
  studio: number;
}

let file: string | null = null;

/** Keep the list in this data folder (the studio does when it starts). */
export function keepStartedIn(dataDir: string): void {
  file = path.join(dataDir, 'started.json');
}

const valid = (e: Entry) => !!e && Number.isInteger(e.pgid) && e.pgid > 1 && typeof e.command === 'string' && typeof e.cwd === 'string' && Number.isInteger(e.studio);

function load(): Entry[] {
  if (!file) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(list) ? (list as Entry[]).filter(valid) : [];
  } catch {
    return [];
  }
}

function save(entries: Entry[]): void {
  if (!file) return;
  try {
    if (!entries.length) fs.rmSync(file, { force: true });
    else {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(entries, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    }
  } catch {
    /* a read-only data folder: nothing kept, as before */
  }
}

/** A command the studio started, in its own process group. */
export function started(pgid: number | undefined, command: string, cwd: string): void {
  if (!file || !pgid || process.platform === 'win32') return;
  save([...load().filter((e) => e.pgid !== pgid), { pgid, command, cwd: path.resolve(cwd), studio: process.pid }]);
}

/** A group this studio started is gone (or stopped). */
export function ended(pgid: number | undefined): void {
  if (!file || !pgid) return;
  const all = load();
  const rest = all.filter((e) => !(e.pgid === pgid && e.studio === process.pid));
  if (rest.length !== all.length) save(rest);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A process's folder, as the system reports it: null when it can't be told. */
function cwdOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`);
    const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 });
    return /^n(.+)$/m.exec(r.stdout ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The processes in a group, with their command lines. */
function members(pgid: number): { pid: number; args: string }[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,args='], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && Number(m[2]) === pgid)
    .map((m) => ({ pid: Number(m[1]), args: m[3] }));
}

const within = (dir: string | null, root: string) => {
  if (!dir) return false;
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* gone: compared as written */
  }
  return [root, real].some((r) => dir === r || dir.startsWith(r + path.sep));
};

/**
 * Whether a group is still what was started. Its first process (the shell) runs the command in the folder; once that
 * shell is gone, the group's number can't be given to another group while any process is left in it, so the processes
 * left are what the command started, provided one of them still works in the folder.
 */
function stillStarted(e: Entry, procs: { pid: number; args: string }[]): boolean {
  const leader = procs.find((p) => p.pid === e.pgid);
  if (leader) return leader.args.includes(e.command) && within(cwdOf(leader.pid), e.cwd);
  return procs.some((p) => within(cwdOf(p.pid), e.cwd));
}

/** Stop the dev servers a studio that ended without stopping them left running. Resolves with how many it stopped. */
export async function stopLeftovers(): Promise<number> {
  if (process.platform === 'win32') return 0;
  const entries = load();
  if (!entries.length) return 0;
  const kept: Entry[] = [];
  let stopped = 0;
  for (const e of entries) {
    // Another studio that runs now on this data folder: its dev servers are its own.
    if (e.studio !== process.pid && alive(e.studio)) {
      kept.push(e);
      continue;
    }
    const procs = members(e.pgid);
    if (!procs.length || !stillStarted(e, procs)) continue;
    try {
      process.kill(-e.pgid, 'SIGTERM');
    } catch {
      continue;
    }
    for (const end = Date.now() + 4000; Date.now() < end && members(e.pgid).length; ) await new Promise((res) => setTimeout(res, 100));
    try {
      if (members(e.pgid).length) process.kill(-e.pgid, 'SIGKILL');
    } catch {
      /* gone */
    }
    stopped++;
  }
  save(kept);
  return stopped;
}
