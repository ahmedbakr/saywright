import { describe, expect, it } from 'vitest';
import { keepUndoHint, previewKey, type KeyPress } from '../../src/core/keys';

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...mods });
const ENTER = press('Enter');
const CTRL_Z = press('z', { ctrlKey: true });
const CMD_Z = press('z', { metaKey: true });

describe('keep and undo from the keyboard', () => {
  it('Enter keeps and Ctrl/⌘ Z undoes a waiting preview, outside text fields', () => {
    expect(previewKey(ENTER, 'page', 1)).toBe('keep');
    expect(previewKey(CTRL_Z, 'page', 1)).toBe('undo');
    expect(previewKey(CMD_Z, 'page', 2)).toBe('undo');
  });

  it('also from the command bar once it is empty: right after a typed request, focus is still there', () => {
    expect(previewKey(ENTER, 'command-empty', 1)).toBe('keep');
    expect(previewKey(CTRL_Z, 'command-empty', 1)).toBe('undo');
  });

  it('text being typed keeps its own Enter and undo', () => {
    expect(previewKey(ENTER, 'command-text', 1)).toBeNull();
    expect(previewKey(CTRL_Z, 'command-text', 1)).toBeNull();
    expect(previewKey(ENTER, 'field', 1)).toBeNull();
    expect(previewKey(CTRL_Z, 'field', 1)).toBeNull();
  });

  it('does nothing without a preview, while composing, held down, or with other keys', () => {
    expect(previewKey(ENTER, 'page', 0)).toBeNull();
    expect(previewKey(press('Enter', { isComposing: true }), 'command-empty', 1)).toBeNull();
    expect(previewKey(press('Enter', { repeat: true }), 'page', 1)).toBeNull();
    expect(previewKey(press('z', { ctrlKey: true, shiftKey: true }), 'page', 1)).toBeNull();
    expect(previewKey(press('Enter', { ctrlKey: true }), 'page', 1)).toBeNull();
    expect(previewKey(press('Enter', { altKey: true }), 'page', 1)).toBeNull();
  });

  it('names the keys as the keyboard does', () => {
    expect(keepUndoHint(false)).toBe('Enter keeps · Ctrl Z undoes');
    expect(keepUndoHint(true)).toBe('Return keeps · ⌘Z undoes');
  });
});
