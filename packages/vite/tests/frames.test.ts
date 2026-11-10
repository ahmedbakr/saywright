/** Only the app's own window records: not a frame inside it. */
import { describe, expect, it } from 'vitest';
import { frameInsideApp } from '../src/bridge/frames';

const win = (parent?: object): Window => {
  const w: Record<string, unknown> = { __saywrightBridge: true };
  w.parent = parent ?? w;
  return w as unknown as Window;
};

describe('a frame inside the app', () => {
  it('is told apart from the app in its own tab and the app the studio frames', () => {
    // Its own tab.
    expect(frameInsideApp(win())).toBe(false);
    // Framed by the studio: the studio's page runs no bridge.
    expect(frameInsideApp(win({}))).toBe(false);
    // Framed by a page of another origin: reading it throws.
    const other = new Proxy({}, { get: () => { throw new DOMException('Blocked a frame', 'SecurityError'); } });
    expect(frameInsideApp(win(other))).toBe(false);
    // A same-origin frame inside the app.
    expect(frameInsideApp(win(win()))).toBe(true);
  });
});
