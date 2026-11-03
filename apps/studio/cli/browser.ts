/** Opening the studio in the person's browser: Chrome when it is there (speech recognition works best in it). */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

function command(url: string): [string, string[]] {
  if (process.platform === 'darwin') return fs.existsSync('/Applications/Google Chrome.app') ? ['open', ['-a', 'Google Chrome', url]] : ['open', [url]];
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]];
  return ['xdg-open', [url]];
}

/** Best effort: where no browser can be opened (a server, a container), the address printed is enough. */
export function openBrowser(url: string): void {
  const [cmd, args] = command(url);
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
      .on('error', () => undefined)
      .unref();
  } catch {
    /* nothing to open it with */
  }
}
