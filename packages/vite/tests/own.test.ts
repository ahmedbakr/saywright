/**
 * What moves right after a replay's or Autopilot's step is that step's doing: the session leaves it out, as the
 * browser does for a person's input.
 */
import { describe, expect, it } from 'vitest';
import { scriptedBefore, scriptedInput } from '../src/bridge/own';

describe('a scripted step', () => {
  it('counts as input for the half second after it, and not before it', () => {
    const before = performance.now();
    expect(scriptedBefore(before)).toBe(false);
    scriptedInput();
    const at = performance.now();
    expect(scriptedBefore(at + 100)).toBe(true);
    expect(scriptedBefore(at + 450)).toBe(true);
    expect(scriptedBefore(at + 700)).toBe(false);
    expect(scriptedBefore(before - 1)).toBe(false);
  });
});
