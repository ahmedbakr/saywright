/**
 * Answers that stream: a file, or a site's answer passed on through the proxy. A browser that goes away halfway
 * (a reload, a cancelled request, a closed tab) stops the stream and frees what fed it, and a source that fails ends
 * the answer. Neither is ever an error nobody listens for, which would end the studio.
 */
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import { pipeline, type Readable, type Transform } from 'node:stream';

/** `from` passed on to `res` as it comes, through `through` (decoding, rewriting). */
export function relay(from: Readable, res: ServerResponse, ...through: Transform[]): void {
  const stop = () => {
    from.destroy();
    for (const t of through) t.destroy();
    if (!res.destroyed) res.destroy();
  };
  // Gone already: nothing to pass on to (piping into a closed answer throws).
  if (res.destroyed || res.writableEnded) return stop();
  try {
    pipeline([from, ...through, res], (err) => {
      if (err) stop();
    });
  } catch {
    stop();
  }
}

/** A file (or a part of it) as the answer. */
export function sendFile(file: string, res: ServerResponse, range?: { start: number; end: number }): void {
  relay(fs.createReadStream(file, range), res);
}
