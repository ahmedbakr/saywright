/**
 * Keep and undo from the keyboard, wherever focus is. Enter keeps the previews waiting for a decision and Ctrl Z
 * (⌘Z on a Mac) undoes them, also from the command bar once it is empty: focus is still there right after a typed
 * request, and the keys the preview island shows must work then. Text being typed keeps its own Enter and undo.
 */

/** Where a key was pressed: outside any text field, in the command bar (empty, or with text), or in another field. */
type KeyPlace = 'page' | 'command-empty' | 'command-text' | 'field';

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

export function previewKey(e: KeyPress, place: KeyPlace, previews: number): 'keep' | 'undo' | null {
  if (!previews || e.repeat || e.isComposing || e.altKey) return null;
  if (place === 'field' || place === 'command-text') return null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter' && !mod) return 'keep';
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') return 'undo';
  return null;
}

/** The keys, as this computer's keyboard names them. */
export const keepUndoHint = (mac: boolean): string => (mac ? 'Return keeps · ⌘Z undoes' : 'Enter keeps · Ctrl Z undoes');
