import { structuredPatch } from 'diff';
import type { DiffFile, DiffLine } from '../shared/api.ts';

export function diffFile(path: string, before: string | null, after: string, context = 3): DiffFile {
  const patch = structuredPatch(path, path, before ?? '', after, undefined, undefined, { context });
  let added = 0;
  let removed = 0;
  const hunks = patch.hunks.map((h) => {
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    const lines: DiffLine[] = [];
    for (const raw of h.lines) {
      const sign = raw[0];
      const text = raw.slice(1);
      if (sign === '\\') continue; // "\ No newline at end of file"
      if (sign === '+') {
        lines.push({ type: 'add', text, newNo: newNo++ });
        added++;
      } else if (sign === '-') {
        lines.push({ type: 'del', text, oldNo: oldNo++ });
        removed++;
      } else {
        lines.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
      }
    }
    return { oldStart: h.oldStart, newStart: h.newStart, lines };
  });
  return { path, hunks, added, removed, created: before === null };
}
