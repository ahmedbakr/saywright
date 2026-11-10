/**
 * The studio's data files that are valid JSON but not of the shape the studio reads (a hand edit, or a file another
 * version wrote): checked as the studio starts, before they are read, and set aside like a damaged file
 * (`<file>.broken-<time>`, with a warning), so the studio starts with its defaults instead of stopping on a TypeError.
 * apps.json is checked where it is read (apps/registry.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** ai.json: which AI does what. Each field, when there, of the type the studio reads. */
export function aiConfigShaped(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (v.custom !== undefined && !(Array.isArray(v.custom) && v.custom.every((c) => isObject(c) && typeof c.id === 'string'))) return false;
  if (v.routes !== undefined && !(isObject(v.routes) && Object.values(v.routes).every((r) => r === null || isObject(r) || typeof r === 'string'))) return false;
  if (v.off !== undefined && !(Array.isArray(v.off) && v.off.every((o) => typeof o === 'string'))) return false;
  if (v.effort !== undefined && typeof v.effort !== 'string') return false;
  return true;
}

/** One line of the AI usage log: a call, with when it was made. */
export const usageLineShaped = (v: unknown): boolean => isObject(v) && typeof v.t === 'number' && Number.isFinite(v.t);

function setAside(file: string, keep: string | null, log: (line: string) => void): void {
  const aside = `${file}.broken-${Date.now()}`;
  try {
    if (keep === null) fs.renameSync(file, aside);
    else {
      fs.copyFileSync(file, aside);
      fs.writeFileSync(file, keep);
    }
    log(`[saywright] ${path.basename(file)} ${keep === null ? 'wasn’t in the shape the studio reads and was moved to' : 'had lines the studio can’t read; they were kept in'} ${aside}.${keep === null ? ' The defaults are used.' : ''}`);
  } catch {
    log(`[saywright] ${file} isn’t in the shape the studio reads, and couldn’t be moved aside.`);
  }
}

/** Check the data files the studio is about to read. */
export function checkDataFiles(dataDir: string, log: (line: string) => void = (line) => console.warn(line)): void {
  const ai = path.join(dataDir, 'ai.json');
  try {
    if (!aiConfigShaped(JSON.parse(fs.readFileSync(ai, 'utf8')))) setAside(ai, null, log);
  } catch {
    /* none yet, or damaged: read as before, which sets a damaged one aside */
  }
  const usage = path.join(dataDir, 'usage');
  let files: string[] = [];
  try {
    files = fs.readdirSync(usage).filter((f) => f.endsWith('.jsonl'));
  } catch {
    /* no usage yet */
  }
  for (const name of files) {
    const file = path.join(usage, name);
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const good = lines.filter((line) => {
        if (!line.trim()) return true;
        try {
          return usageLineShaped(JSON.parse(line));
        } catch {
          // A torn last line, from a studio stopped mid-write: the log skips it, as it always has.
          return true;
        }
      });
      if (good.length !== lines.length) setAside(file, good.join('\n'), log);
    } catch {
      /* unreadable: the log reads what it can */
    }
  }
}
