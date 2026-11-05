/**
 * Starting a session waits on the browser asking to share the screen. A question that is never answered (or never
 * asked) ends the start after a while, with what to do; cancelling works all along; a share allowed too late is let go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNTDOWN_FADE_MS, SCREEN_WAIT_MS, SessionClient } from '../src/client';

const opts = { endpoint: 'http://localhost:7357', lang: 'en' as const, appUrl: 'http://localhost:5174/', source: 'studio' as const, mic: false, screen: true, video: false, countdown: 0 };

let created = 0;
let allow: (stream: unknown) => void = () => undefined;

beforeEach(() => {
  created = 0;
  vi.useFakeTimers();
  // The browser asks to share the screen; nothing answers until a test says so.
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => new Promise((resolve) => (allow = resolve)) } });
  vi.stubGlobal('fetch', async () => {
    created++;
    return new Response(JSON.stringify({ session: { id: 's1', startedAt: Date.now() }, key: 'k' }));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('starting a session while the screen share goes unanswered', () => {
  it('gives up after a while, says what to do, and creates nothing', async () => {
    const c = new SessionClient();
    const started = c.start(opts);
    const failed = expect(started).rejects.toThrow(/Sharing the screen didn’t start/);
    await vi.advanceTimersByTimeAsync(SCREEN_WAIT_MS - 1000);
    expect(c.state.status).toBe('starting');
    await vi.advanceTimersByTimeAsync(2000);
    await failed;
    expect(c.state).toMatchObject({ status: 'failed', id: null, countdown: null });
    expect(c.state.error).toContain('turn off “Record the screen”');
    expect(created).toBe(0);
  });

  it('can be cancelled meanwhile, and is then as if it never started', async () => {
    const c = new SessionClient();
    const started = c.start(opts);
    await vi.advanceTimersByTimeAsync(3000);
    c.cancelStart();
    await expect(started).resolves.toBeNull();
    expect(c.state.status).toBe('idle');
    expect(created).toBe(0);
  });

  it('lets go of a share allowed after it was cancelled', async () => {
    const c = new SessionClient();
    const started = c.start(opts);
    c.cancelStart();
    await expect(started).resolves.toBeNull();
    const stop = vi.fn();
    allow({ getVideoTracks: () => [{ addEventListener: () => undefined }], getTracks: () => [{ stop }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(stop).toHaveBeenCalled();
  });
});

describe('the video of a session started after a countdown', () => {
  it('starts once the countdown has left the screen, so its first frame and the start’s picture show the app', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16));
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    vi.stubGlobal('addEventListener', () => undefined);
    const c = new SessionClient();
    const did: { what: string; at: number }[] = [];
    // The screen, shared at once.
    const screen = { start: async () => undefined, record: () => void did.push({ what: 'video', at: Date.now() }), shoot: () => void did.push({ what: 'picture', at: Date.now() }), stop: async () => undefined, onEnded: null, active: true };
    (c as unknown as { makeScreen: () => typeof screen }).makeScreen = () => screen;
    let gone = 0;
    c.subscribe((s) => {
      if (s.id && !s.countdown && !gone) gone = Date.now();
    });
    const started = c.start({ ...opts, countdown: 1 });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(started).resolves.toBe('s1');
    expect(gone).toBeGreaterThan(0);
    expect(did.map((d) => d.what)).toEqual(['video', 'picture']);
    expect(did[0].at - gone).toBeGreaterThanOrEqual(COUNTDOWN_FADE_MS);
  });
});
