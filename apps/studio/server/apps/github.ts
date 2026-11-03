/**
 * A GitHub repository, cloned onto this computer to work on: with the GitHub
 * CLI when it is signed in (private repositories too), else with git and the
 * credentials it already has. Never prompts in a terminal: if a repository
 * needs signing in, the error says how.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface RepoRef {
  owner: string;
  name: string;
  /** What git clones from. */
  url: string;
}

/** "owner/name", https://github.com/owner/name(.git), git@github.com:owner/name.git, or any other git URL. */
function parseRepo(input: string): RepoRef {
  const s = input.trim().replace(/\/+$/, '');
  let m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (m) return { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}.git` };
  m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/.*)?$/.exec(s);
  if (m) return { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}.git` };
  m = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (m) return { owner: m[1], name: m[2], url: s.endsWith('.git') ? s : `${s}.git` };
  m = /^(?:https?|ssh|git):\/\/[^/]+\/(?:.+\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (m) return { owner: m[1], name: m[2], url: s };
  throw new Error('That isn’t a repository address. Use owner/name or its https://github.com/… address.');
}

function ghSignedIn(): boolean {
  try {
    return spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 8000 }).status === 0;
  } catch {
    return false;
  }
}

/** A folder for the clone: <parent>/<name>, or <name>-2… when that is taken by something else. */
function cloneTarget(parent: string, ref: RepoRef): { dir: string; existing: boolean } {
  for (let i = 1; i < 50; i++) {
    const dir = path.join(parent, i === 1 ? ref.name : `${ref.name}-${i}`);
    if (!fs.existsSync(dir)) return { dir, existing: false };
    // Cloned before: use it as it is.
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).stdout?.trim();
    if (remote && remote.replace(/\.git$/, '').toLowerCase().endsWith(`${ref.owner}/${ref.name}`.toLowerCase())) return { dir, existing: true };
  }
  throw new Error(`Too many folders named ${ref.name} in ${parent}`);
}

/** Clone `input` under `parent`. Progress lines go to `onLine`. Resolves with the clone's folder. */
export function cloneRepo(input: string, parent: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<{ dir: string; existing: boolean }> {
  const ref = parseRepo(input);
  fs.mkdirSync(parent, { recursive: true });
  const { dir, existing } = cloneTarget(parent, ref);
  if (existing) {
    onLine(`Already cloned at ${dir}`);
    return Promise.resolve({ dir, existing });
  }
  const gh = /github\.com/.test(ref.url) && ghSignedIn();
  // Full history, file contents fetched as needed: quick, and later pulls work.
  const [cmd, args] = gh ? ['gh', ['repo', 'clone', `${ref.owner}/${ref.name}`, dir, '--', '--filter=blob:none', '--progress']] : ['git', ['clone', '--filter=blob:none', '--progress', ref.url, dir]];
  onLine(`$ ${cmd} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const read = (d: Buffer) => {
      for (const line of d.toString().split(/[\r\n]+/)) {
        const l = line.trim();
        if (l && l !== last) {
          last = l;
          onLine(l.slice(0, 300));
        }
      }
    };
    proc.stdout.on('data', read);
    proc.stderr.on('data', read);
    signal?.addEventListener('abort', () => proc.kill('SIGTERM'));
    proc.on('error', (err) => reject(new Error(cmd === 'git' ? 'git isn’t installed. Install it from git-scm.com.' : err.message)));
    proc.on('exit', (code) => {
      if (code === 0) return resolve({ dir, existing: false });
      fs.rmSync(dir, { recursive: true, force: true });
      if (/authentication|could not read username|permission denied|repository not found|403|401/i.test(last)) {
        reject(new Error(gh ? `GitHub refused access to ${ref.owner}/${ref.name}. Check the name, and that your GitHub account can see it.` : `${ref.owner}/${ref.name} needs signing in (or doesn’t exist). Install the GitHub CLI and run “gh auth login”, or use its SSH address.`));
      } else reject(new Error(`Cloning failed: ${last || `exit ${code}`}`));
    });
  });
}
