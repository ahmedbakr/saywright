/**
 * Apps `saywright connect` has set up for the studio to link the next time it starts: target.json in its data folder,
 * a list (each connect adds its app; one connected again moves to the end, and the last opens first).
 */
import fs from 'node:fs';

export interface ConnectedTarget {
  url: string;
  root: string;
  framework?: string;
  start?: string | null;
  studio?: string;
}

/** The apps waiting in `file` (a file from an older version holds one). */
export function connectedTargets(file: string): ConnectedTarget[] {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { targets?: unknown; url?: unknown; root?: unknown };
    const list = Array.isArray(saved.targets) ? saved.targets : [saved];
    return list.filter((t): t is ConnectedTarget => !!t && typeof (t as { url?: unknown }).url === 'string' && typeof (t as { root?: unknown }).root === 'string');
  } catch {
    return [];
  }
}
