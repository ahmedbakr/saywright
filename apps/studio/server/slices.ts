/**
 * Long work on the server's one thread, in slices: a loop calls `breathe()` as it goes, and every few milliseconds
 * that lets the server answer other requests (the event stream, an app's recording, /api/status) before it goes on.
 * Every loop shares the same slice, so ten searches at once still leave the server free every few milliseconds.
 */
const SLICE_MS = 8;

let sliceStart = performance.now();
let waiting: Promise<void> | null = null;

/** Resolves at once while the current slice lasts; after it, once the server has had its turn. */
export function breathe(): Promise<void> {
  if (performance.now() - sliceStart < SLICE_MS) return Promise.resolve();
  waiting ??= new Promise<void>((resolve) =>
    setImmediate(() => {
      waiting = null;
      sliceStart = performance.now();
      resolve();
    }),
  );
  return waiting;
}
