/** Downloading the studio's optional extras (speech and hand models) to this computer, and unpacking them safely. */
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

/**
 * Download `url` to `dest`, through a `.part` file so an interrupted download never looks finished. Falls back to
 * curl, which honours HTTPS_PROXY and the corporate proxies Node's fetch ignores. The file must have the SHA-256
 * `expect` (pinned for every download), or it is thrown away.
 */
export async function download(url: string, dest: string, onProgress: ((fraction: number) => void) | undefined, expect: string): Promise<void> {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(part);
    let got = 0;
    let last = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total && onProgress && got - last > total / 100) {
        last = got;
        onProgress(got / total);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch {
    await new Promise<void>((resolve, reject) => {
      const curl = spawn('curl', ['-fsSL', '--retry', '2', '-o', part, url], { stdio: 'ignore' });
      curl.on('error', reject);
      curl.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Download failed (curl ${code})`))));
    });
  }
  if ((await sha256(part)) !== expect) {
    fs.rmSync(part, { force: true });
    throw new Error(`The download from ${new URL(url).host} isn’t the file it should be (its checksum differs).`);
  }
  fs.renameSync(part, dest);
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
