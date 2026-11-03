/**
 * Saywright's own work on the app's page (reading the screen, building
 * locators, answering the studio): timed, so a slow moment it caused is never
 * reported as the app's.
 */
const spans: [number, number][] = [];

/** Run some of our own work, remembering when it ran if it took long enough to matter. */
export function own<T>(fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const end = performance.now();
    if (end - start >= 8) {
      spans.push([start, end]);
      if (spans.length > 64) spans.splice(0, spans.length - 64);
    }
  }
}

/** How much of [start, end] (performance.now() times) was our own work. */
export function ownTime(start: number, end: number): number {
  let ms = 0;
  for (const [a, b] of spans) ms += Math.max(0, Math.min(b, end) - Math.max(a, start));
  return ms;
}
