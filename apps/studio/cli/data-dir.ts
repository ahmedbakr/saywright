/**
 * The data folder, checked before a command uses it: a folder Saywright can't write (made by another account, after
 * one `sudo npx @saywright/studio`; on a read-only disk) or a file where the folder should be would otherwise stop the
 * command on a raw system error, half-way through.
 */
import fs from 'node:fs';
import path from 'node:path';

/** What is wrong with the data folder, in a sentence for the person; null when Saywright can use it. */
export function dataDirProblem(dir: string): string | null {
  const why = (err: unknown, what: string) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') return `${what} is a file, not a folder`;
    if (code === 'EACCES' || code === 'EPERM') return `${what} belongs to another account, or isn’t writable (it may have been made with sudo)`;
    if (code === 'EROFS') return `${what} is on a read-only disk`;
    return `${what}: ${err instanceof Error ? err.message : err}`;
  };
  const say = (reason: string) => `Saywright can’t use its data folder ${dir}: ${reason}. Fix its owner (or remove it), or set SAYWRIGHT_HOME to another folder.`;
  try {
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) return say('it is a file, not a folder');
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return say(why(err, 'it, or a folder above it,'));
  }
  const probe = path.join(dir, `.write-check-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    return say(why(err, 'it'));
  }
  // What the studio reads first: unreadable when another account made them.
  for (const file of ['.env.local', 'mcp-token', 'apps.json']) {
    try {
      fs.closeSync(fs.openSync(path.join(dir, file), 'r'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return say(why(err, `its ${file}`));
    }
  }
  return null;
}
