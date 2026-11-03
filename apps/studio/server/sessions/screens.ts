/**
 * What the screen said during a session, as a report can check it: each page's text as it opened, then what changed
 * once the screen settled after each action (a total going from $98.00 to $78.40 after “Apply”), as a short diff.
 * The app's page reads the screen (see the bridge's session recorder); this turns those reads into evidence.
 */
import type { ScreenText, TimelineItem } from '../../shared/session.ts';

/** One read of the screen, with the action it followed. */
export interface Look {
  t: number;
  url: string;
  reason: string;
  text: string;
  action: TimelineItem | null;
}

/** Lines of a page shown in full, and of one diff. */
const FULL_LINES = 60;
const DIFF_LINES = 30;
/** What the analysis keeps, at most. */
const MAX_SCREENS = 150;
const MAX_CHARS = 60_000;
/** Past this many line comparisons (a screen is read up to 4,000 characters), two screens are told apart as a whole. */
const MAX_COMPARE = 250_000;

type Op = { op: ' ' | '-' | '+'; line: string };

/**
 * `next` against `prev`, line by line: “+ ” appeared, “- ” went away, “  ” unchanged around a change (`before` lines
 * before it, `after` after it), “…” for unchanged lines left out. `changed` counts the lines that changed.
 */
export function lineDiff(prev: string[], next: string[], before = 2, after = 1): { lines: string[]; changed: number } {
  // A change is usually in one place: the same start and end are set aside, the middle compared line by line.
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const a = prev.slice(head, prev.length - tail);
  const b = next.slice(head, next.length - tail);
  const ops: Op[] = prev.slice(0, head).map((line) => ({ op: ' ', line }));
  if (a.length * b.length > MAX_COMPARE) {
    for (const line of a) ops.push({ op: '-', line });
    for (const line of b) ops.push({ op: '+', line });
  } else {
    // The longest run of lines both have in common (a table, filled from the end), then a walk along it.
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ op: ' ', line: a[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: '-', line: a[i++] });
      else ops.push({ op: '+', line: b[j++] });
    }
    while (i < a.length) ops.push({ op: '-', line: a[i++] });
    while (j < b.length) ops.push({ op: '+', line: b[j++] });
  }
  for (const line of next.slice(next.length - tail)) ops.push({ op: ' ', line });

  const keep = new Uint8Array(ops.length);
  let changed = 0;
  ops.forEach((o, k) => {
    if (o.op === ' ') return;
    changed++;
    for (let x = Math.max(0, k - before); x <= Math.min(ops.length - 1, k + after); x++) keep[x] = 1;
  });
  const lines: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (!keep[k]) {
      skipped = true;
      return;
    }
    if (skipped) lines.push('…');
    skipped = false;
    lines.push(`${o.op} ${o.line}`);
  });
  if (skipped && lines.length) lines.push('…');
  return { lines, changed };
}

/**
 * The reads of a session as evidence: a page in full the first time it shows, then each read that found something
 * changed as a diff, with the action it followed. Long sessions keep an even spread of them, within a size.
 */
export function screenTexts(looks: Look[]): ScreenText[] {
  const out: ScreenText[] = [];
  let prev: { url: string; lines: string[] } | null = null;
  for (const l of looks) {
    const lines = l.text.split('\n').filter(Boolean);
    const after = l.reason === 'after' && l.action ? { after: { ...(l.action.id ? { id: l.action.id } : {}), text: l.action.text } } : {};
    if (prev && prev.url === l.url) {
      const d = lineDiff(prev.lines, lines);
      prev = { url: l.url, lines };
      if (!d.changed) continue;
      out.push({ t: l.t, url: l.url, moment: l.reason, ...after, diff: true, lines: d.lines.slice(0, DIFF_LINES), ...(d.lines.length > DIFF_LINES ? { more: d.lines.length - DIFF_LINES } : {}) });
    } else {
      prev = { url: l.url, lines };
      if (!lines.length) continue;
      out.push({ t: l.t, url: l.url, moment: l.reason, ...after, diff: false, lines: lines.slice(0, FULL_LINES), ...(lines.length > FULL_LINES ? { more: lines.length - FULL_LINES } : {}) });
    }
  }
  return spread(out);
}

const size = (s: ScreenText) => s.lines.reduce((n, l) => n + l.length + 1, 0);

/** Within MAX_SCREENS and MAX_CHARS: the first read, and the others evenly over the session. */
function spread(all: ScreenText[]): ScreenText[] {
  let kept = all;
  for (let step = 2; kept.length > MAX_SCREENS || kept.reduce((n, s) => n + size(s), 0) > MAX_CHARS; step++) {
    kept = all.filter((_, i) => i % step === 0);
    if (kept.length <= 1) break;
  }
  return kept;
}

/** The words that changed (appeared or went away) on screen after actions. */
export function changedLines(screens: ScreenText[] | undefined): string[] {
  return (screens ?? []).filter((s) => s.diff).flatMap((s) => s.lines.filter((l) => l.startsWith('+ ') || l.startsWith('- ')).map((l) => l.slice(2)));
}
