/** Downloading the studio's optional extras (speech and voice models) to this computer, and unpacking them safely. */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

/** Silence this long while a body arrives, and the download is taken for stalled (a slow link is fine). */
const IDLE_MS = 60_000;

/** Why a request failed, in words: the server's answer, or the network's. */
function reason(err: unknown, host: string): string {
  if (err instanceof Error && /^HTTP \d+/.test(err.message)) return `${err.message} from ${host}`;
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${host} couldn’t be found (no connection, or a proxy is needed)`;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `the connection to ${host} was refused or dropped`;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `${host} sent nothing for ${IDLE_MS / 1000} seconds`;
  return err instanceof Error ? err.message : String(err);
}

/** What curl's exit code means. */
const CURL: Record<number, string> = { 6: 'couldn’t find the host', 7: 'couldn’t connect', 22: 'the server answered with an error', 28: 'timed out', 35: 'the secure connection failed', 56: 'the connection dropped' };

const size = (file: string) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/** One request, continuing what `part` already holds. Resolves with the whole size when the server says it. */
async function fetchInto(url: string, part: string, onProgress?: (fraction: number) => void): Promise<number> {
  const have = size(part);
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(new DOMException('stalled', 'TimeoutError')), IDLE_MS);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new DOMException('stalled', 'TimeoutError')), IDLE_MS);
  };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: idle.signal, headers: have ? { Range: `bytes=${have}-` } : {} });
    // Asked for the rest of a file that is whole already: the checksum says whether it is.
    if (res.status === 416 && have) return have;
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const resumed = res.status === 206;
    const total = (resumed ? have : 0) + (Number(res.headers.get('content-length')) || 0);
    const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    let got = resumed ? have : 0;
    let last = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        alive();
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (total && onProgress && got - last > total / 100) {
          last = got;
          onProgress(got / total);
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
    return total;
  } finally {
    clearTimeout(timer);
  }
}

/** The last resort: curl, which follows HTTPS_PROXY itself and continues the file (-C -). Progress from the file's size. */
function curlInto(url: string, part: string, total: number, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', ['-fsSL', '--retry', '2', '--speed-limit', '1', '--speed-time', String(IDLE_MS / 1000), '-C', '-', '-o', part, url], { stdio: 'ignore' });
    const tick = total && onProgress ? setInterval(() => onProgress(Math.min(size(part) / total, 1)), 500) : null;
    const done = (err?: Error) => {
      if (tick) clearInterval(tick);
      if (err) reject(err);
      else resolve();
    };
    curl.on('error', (err) => done((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('curl isn’t installed') : err));
    curl.on('exit', (code) => (code === 0 ? done() : done(new Error(`curl ${CURL[code ?? 0] ?? `stopped with code ${code}`}`))));
  });
}

/**
 * Download `url` to `dest`, through a `.part` file so an interrupted download never looks finished. A dropped
 * connection or a stalled one is continued where it stopped (a Range request), twice; then curl, which honours
 * HTTPS_PROXY and the corporate proxies Node's fetch ignores, continues it. The file must have the SHA-256 `expect`
 * (pinned for every download), or it is thrown away. A failure says why: the server's answer, or the network's.
 */
export async function download(url: string, dest: string, onProgress: ((fraction: number) => void) | undefined, expect: string, onRetry?: (why: string) => void): Promise<void> {
  const part = `${dest}.part`;
  const host = new URL(url).host;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let total = 0;
  let first: string | null = null;
  let done = false;
  for (let attempt = 0; attempt < 3 && !done; attempt++) {
    try {
      total = (await fetchInto(url, part, onProgress)) || total;
      done = true;
    } catch (err) {
      first ??= reason(err, host);
      // A refusal (404, 403) won't change on a second try.
      if (err instanceof Error && /^HTTP 4\d\d/.test(err.message) && err.message !== 'HTTP 416') break;
      onRetry?.(reason(err, host));
    }
  }
  if (!done) {
    onRetry?.(`${first}; trying again with curl`);
    try {
      await curlInto(url, part, total, onProgress);
    } catch (err) {
      throw new Error(`Download from ${host} failed: ${first}; then ${err instanceof Error ? err.message : err}.`);
    }
  }
  if ((await sha256(part)) !== expect) {
    fs.rmSync(part, { force: true });
    throw new Error(`The download from ${host} isn’t the file it should be (its checksum differs).`);
  }
  fs.renameSync(part, dest);
}

/**
 * Remove what downloads left in a folder: the partial files (`<name>.part`) of these downloads, and those that are
 * archives, not unpacked yet. Only these names: the folder may be one of yours (SAYWRIGHT_SPEECH_DIR). Called as
 * setup and the studio start, and when setup is stopped, so a stopped 1.6 GB download doesn't stay on the disk.
 */
export function removePartials(dir: string, names: string[]): void {
  for (const name of names) {
    for (const file of [`${name}.part`, ...(name.endsWith('.tar.bz2') ? [name] : [])]) {
      try {
        fs.rmSync(path.join(dir, file), { force: true });
      } catch {
        /* not ours to remove after all: left */
      }
    }
  }
}

/** Whether this computer can unpack the models (tar, and bzip2 for it; Windows' own tar reads bzip2 itself). */
export function missingUnpackers(exists: (cmd: string) => boolean): string[] {
  return ['tar', ...(process.platform === 'win32' ? [] : ['bzip2'])].filter((cmd) => !exists(cmd));
}

/**
 * Unpack a .tar.bz2 into `dest`, after checking every entry is a plain file or folder that lands inside it: an
 * archive with absolute paths, `..` or links could otherwise write anywhere.
 */
export async function extractTarBz2(archive: string, dest: string): Promise<void> {
  const listing = await new Promise<string>((resolve, reject) =>
    execFile('tar', ['-tvjf', archive], { maxBuffer: 64 << 20 }, (err, stdout) => (err ? reject(new Error(`Couldn’t read the archive: ${err.message}`)) : resolve(stdout))),
  );
  const names = await new Promise<string>((resolve, reject) => execFile('tar', ['-tjf', archive], { maxBuffer: 64 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
  for (const line of listing.split('\n').filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') throw new Error('The archive holds links or devices: not unpacked.');
  }
  for (const name of names.split('\n').filter(Boolean)) {
    const target = path.resolve(dest, name);
    const rel = path.relative(dest, target);
    if (path.isAbsolute(name) || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`The archive would write outside its folder (${name}): not unpacked.`);
  }
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xjf', archive, '--no-same-owner', '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    tar.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    tar.on('error', reject);
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar exited with ${code}`))));
  });
}
