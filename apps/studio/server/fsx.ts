/**
 * Saving the studio's own state so a crash, a full disk or a power cut mid-save can't lose it. A file is written
 * beside its place and renamed over it (a reader sees the old copy or the new one, never half of one), and settings
 * keep their last good copy (`<file>.bak`). A file that is damaged anyway is set aside with a warning, not silently
 * replaced by defaults that the next save would make permanent.
 */
import fs from 'node:fs';
import path from 'node:path';

let counter = 0;

interface WriteOptions {
  /** Permissions for a new file (0o600 for secrets: readable by this user only, from the first byte). */
  mode?: number;
  /** Keep the copy being replaced as `<file>.bak`, for readJson to fall back on. Not for secrets: a removed key must go. */
  keepPrevious?: boolean;
  /**
   * Wait for the disk before the rename (default), so even a power cut leaves the old or the new file. State saved
   * every second while recording (a session's counts) skips the wait: a copy a second old is fine there.
   */
  sync?: boolean;
}

/** Write a whole file so that it is replaced at once. */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: WriteOptions = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${++counter}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', opts.mode ?? 0o666);
    try {
      fs.writeFileSync(fd, data);
      if (opts.sync !== false) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (opts.mode !== undefined) fs.chmodSync(tmp, opts.mode);
    if (opts.keepPrevious) keepCopy(file);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The current file becomes `<file>.bak` (a second name for it, so the file itself never goes missing). */
function keepCopy(file: string): void {
  const bak = `${file}.bak`;
  try {
    fs.rmSync(bak, { force: true });
    fs.linkSync(file, bak);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    // A file system without hard links: a plain copy.
    try {
      fs.copyFileSync(file, bak);
    } catch {
      /* no copy this time; the save itself still goes ahead */
    }
  }
}

/** JSON settings, keeping the last good copy. */
export function writeJson(file: string, value: unknown, opts: WriteOptions = {}): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { keepPrevious: true, ...opts });
}

/**
 * A JSON file written by writeJson, or undefined when there is none yet. A damaged one is moved aside
 * (`<file>.broken-<time>`, with a warning) and the last good copy is used instead.
 */
export function readJson<T>(file: string): T | undefined {
  const main = parseFile<T>(file);
  if (main.ok) return main.value;
  // No file: a first run, or one removed on purpose to start over (the copy isn't brought back then).
  if (!main.damaged) return undefined;
  const aside = `${file}.broken-${Date.now()}`;
  const bak = parseFile<T>(`${file}.bak`);
  try {
    fs.renameSync(file, aside);
    console.warn(`[saywright] ${path.basename(file)} was damaged and was moved to ${aside}. ${bak.ok ? 'Its last good copy is used instead.' : 'There is no earlier copy, so the defaults are used.'}`);
  } catch {
    console.warn(`[saywright] ${file} is damaged and couldn’t be moved aside.`);
  }
  return bak.ok ? bak.value : undefined;
}

function parseFile<T>(file: string): { ok: true; value: T } | { ok: false; damaged: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, damaged: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, damaged: true };
  }
}
