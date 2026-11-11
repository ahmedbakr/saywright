/**
 * The plugin in an app and the studio are updated separately: which one has to
 * be updated when they can't work together, and that sides which don't say
 * how old a side they accept are still told apart.
 */
import { describe, expect, it } from 'vitest';
import { OLDEST_PROTOCOL, PROTOCOL_VERSION, outdated } from '../src/protocol';

describe('protocol versions', () => {
  it('this studio and this plugin work together', () => {
    const now = { v: PROTOCOL_VERSION, oldest: OLDEST_PROTOCOL };
    expect(outdated(now, now)).toBeNull();
  });

  it('a plugin or a studio from 0.3.0 or before (they say 1) is named: its page does nothing of what the studio now relies on', () => {
    const now = { v: PROTOCOL_VERSION, oldest: OLDEST_PROTOCOL };
    // An app whose plugin wasn't updated with the studio: the page wouldn't refuse anything for Autopilot.
    expect(outdated(now, { v: 1, oldest: 1 })).toBe('plugin');
    // The first release sent its version only.
    expect(outdated(now, { v: 1 })).toBe('plugin');
    // And the other way round: a studio from then, with an app whose plugin was updated first.
    expect(outdated({ v: 1, oldest: 1 }, now)).toBe('studio');
    expect(outdated({ v: 1 }, now)).toBe('studio');
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
