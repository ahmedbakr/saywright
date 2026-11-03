/**
 * The plugin in an app and the studio are updated separately: which one has to
 * be updated when they can't work together, and that older but compatible
 * sides (which don't say how old a side they accept) still work.
 */
import { describe, expect, it } from 'vitest';
import { OLDEST_PROTOCOL, PROTOCOL_VERSION, outdated } from '../src/protocol';

describe('protocol versions', () => {
  it('this studio and this plugin work together, and with the first version of either', () => {
    const now = { v: PROTOCOL_VERSION, oldest: OLDEST_PROTOCOL };
    expect(outdated(now, now)).toBeNull();
    // The first release sent its version only.
    expect(outdated(now, { v: 1 })).toBeNull();
    expect(outdated({ v: 1 }, now)).toBeNull();
  });

  it('names the app’s plugin when it is older than the studio still understands', () => {
    expect(outdated({ v: 3, oldest: 2 }, { v: 1 })).toBe('plugin');
    expect(outdated({ v: 3, oldest: 2 }, { v: 2, oldest: 1 })).toBeNull();
  });

  it('names the studio when the app’s plugin needs a newer one', () => {
    expect(outdated({ v: 1 }, { v: 3, oldest: 2 })).toBe('studio');
    expect(outdated({ v: 2, oldest: 1 }, { v: 3, oldest: 2 })).toBeNull();
  });

  it('a newer side that still accepts the older one is no problem', () => {
    expect(outdated({ v: 4, oldest: 1 }, { v: 1 })).toBeNull();
    expect(outdated({ v: 1 }, { v: 4, oldest: 1 })).toBeNull();
  });
});
