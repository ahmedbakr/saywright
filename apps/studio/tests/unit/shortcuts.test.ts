import { describe, expect, it } from 'vitest';
import { keys, shortcut } from '../../src/lib/format';

describe('shortcut labels, as each computer names its keys', () => {
  it('on a Mac: ⌘ ⌥ ⇧ glyphs, run together', () => {
    expect(keys('mod+z', true)).toEqual(['⌘', 'Z']);
    expect(keys('alt+shift+m', true)).toEqual(['⌥', '⇧', 'M']);
    expect(shortcut('mod+k', true)).toBe('⌘K');
    expect(shortcut('alt+shift+m', true)).toBe('⌥⇧M');
    // A word keeps its space.
    expect(shortcut('shift+click', true)).toBe('⇧ click');
  });

  it('elsewhere: Ctrl, Alt and Shift spelled out', () => {
    expect(keys('mod+z', false)).toEqual(['Ctrl', 'Z']);
    expect(keys('alt+Click', false)).toEqual(['Alt', 'Click']);
    expect(shortcut('mod+k', false)).toBe('Ctrl K');
    expect(shortcut('alt+shift+m', false)).toBe('Alt Shift M');
  });

  it('names the keys that have a symbol', () => {
    expect(shortcut('enter', false)).toBe('↵');
    expect(shortcut('mod+enter', true)).toBe('⌘↵');
    expect(keys('esc', true)).toEqual(['Esc']);
  });
});
