/**
 * What the AI is asked when a report's finding is sent to be fixed: the evidence once each, where the problem
 * showed and its likely cause, and the tester's words without repeats.
 */
import { describe, expect, it } from 'vitest';
import type { ReportFinding, SessionAnalysis, TimelineItem } from '../../shared/session';
import { evidenceItems, findingBrief } from '../../src/core/evidence';

const said: TimelineItem = { id: 'S5', t: 5, kind: 'speech', text: 'The total looks wrong. This should show $80.80.' };
const rested: TimelineItem = { id: 'E13', t: 4, kind: 'action', text: 'Rested on “Discount (SAVE20)−$19.60” for 15.0 s' };
const analysis = {
  timeline: [rested, said],
  // The issue the studio found in that sentence: its evidence is the sentence.
  issues: [{ id: 'I1', key: 'said:4', count: 1, evidence: ['S5'], kind: 'said', severity: 'high', title: '“The total looks wrong.”', t: 5 }],
} as unknown as SessionAnalysis;
const finding: ReportFinding = {
  id: 'F1',
  category: 'bug',
  severity: 'high',
  title: 'Total after SAVE20 is $78.40, not $80.80',
  what: 'SAVE20 took 20% of the subtotal plus shipping.',
  expected: 'Only the items are discounted: $80.80.',
  quote: 'The total looks wrong.',
  // The sentence, and the issue that stands for the same sentence.
  evidence: ['S5', 'I1', 'E13'],
  shown: 'src/components/OrderSummary.tsx:24',
  location: 'src/lib/pricing.ts:32',
  fix: 'Discount the subtotal only.',
  steps: [],
  confidence: 'high',
};

describe('a finding sent to be fixed', () => {
  it('has each piece of evidence once, in time order', () => {
    expect(evidenceItems(finding, analysis).map((x) => x.id)).toEqual(['E13', 'S5']);
  });

  it('quotes the tester once, and says where it showed and where the cause likely is', () => {
    const brief = findingBrief(finding, evidenceItems(finding, analysis));
    expect(brief.filter((l) => l.startsWith('The tester said:'))).toEqual(['The tester said: “The total looks wrong. This should show $80.80.”']);
    expect(brief).toContain('Showed at: src/components/OrderSummary.tsx:24');
    expect(brief).toContain('Likely cause: src/lib/pricing.ts:32');
    expect(brief).toContain('Recorded: Rested on “Discount (SAVE20)−$19.60” for 15.0 s');
  });

  it('names one place when it showed where the cause is', () => {
    const brief = findingBrief({ ...finding, shown: 'src/lib/pricing.ts:32' }, []);
    expect(brief.some((l) => l.startsWith('Showed at:'))).toBe(false);
    expect(brief).toContain('Likely cause: src/lib/pricing.ts:32');
  });
});
