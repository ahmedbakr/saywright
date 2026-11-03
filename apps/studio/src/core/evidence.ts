import type { ReportFinding, SessionAnalysis, TimelineItem } from '@shared/session';

/** The evidence a finding points at, resolved to timeline items: each once, in time order. */
export function evidenceItems(f: ReportFinding, a: SessionAnalysis): TimelineItem[] {
  const byId = new Map(a.timeline.map((x) => [x.id, x]));
  const out = new Set<TimelineItem>();
  for (const id of f.evidence) {
    const it = byId.get(id);
    if (it) out.add(it);
    else {
      // An issue stands for its own evidence (a sentence the finding may also name).
      const issue = a.issues.find((g) => g.id === id);
      for (const e of issue?.evidence ?? []) {
        const x = byId.get(e);
        if (x) out.add(x);
      }
    }
  }
  return Array.from(out).sort((x, y) => x.t - y.t);
}

/**
 * A finding as the AI is asked to fix it: what happened, where it showed and its likely cause, what the tester
 * said (each sentence once) and what was recorded.
 */
export function findingBrief(f: ReportFinding, items: TimelineItem[]): string[] {
  const said = Array.from(new Set(items.filter((x) => x.kind === 'speech').map((x) => `“${x.text}”`)));
  const happened = Array.from(new Set(items.filter((x) => x.kind !== 'speech' && x.kind !== 'shot').map((x) => x.text)));
  return [
    `What happened: ${f.what}`,
    f.expected ? `Expected: ${f.expected}` : '',
    f.shown && f.shown !== f.location ? `Showed at: ${f.shown}` : '',
    f.location ? `Likely cause: ${f.location}` : '',
    f.fix ? `Suggested fix: ${f.fix}` : '',
    said.length ? `The tester said: ${said.join(' ')}` : '',
    happened.length ? `Recorded: ${happened.slice(0, 5).join('; ')}` : '',
  ].filter(Boolean);
}
