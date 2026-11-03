/**
 * A check on a whole row receives "Total$78.40" when "$80.80" was expected:
 * pick out the part that has the same shape as the expectation.
 */
export function focusOn(received: string | undefined, expected: string | undefined): string | undefined {
  if (!received || !expected || received === expected) return received;
  const shape = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+');
  if (shape === expected || !/\\d\+/.test(shape)) return received;
  return new RegExp(shape).exec(received)?.[0] ?? received;
}
