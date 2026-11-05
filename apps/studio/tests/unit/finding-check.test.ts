/**
 * A test made from a report's finding: its check is read where the problem showed (not at the finding's last evidence,
 * which can be a payment made later), and a finding whose evidence names no element finds one its expected value is
 * named after.
 */
import { describe, expect, it } from 'vitest';
import type { ReportFinding, SessionAnalysis, SessionTarget } from '@shared/session';
import { findingCheck, namedCheck } from '../../src/core/replay';

const total: SessionTarget = { src: 'src/OrderSummary.tsx:20:5', name: 'SummaryRow', tag: 'div', role: null, rect: [0, 0, 300, 24], label: 'Total', text: 'Total $78.40', locator: "page.getByTestId('summary-total')", description: 'the Total row' };
const pay: SessionTarget = { src: 'src/OrderSummary.tsx:30:5', name: 'Button', tag: 'button', role: 'button', rect: [0, 40, 300, 40], label: 'Pay $78.40', text: 'Pay $78.40', locator: "page.getByRole('button', { name: /^Pay / })" };

function analysis(over: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return {
    version: 1,
    durationMs: 12_000,
    pages: [],
    issues: [{ id: 'i1', kind: 'observed', severity: 'high', title: 'Wrong total', detail: '', t: 2000, count: 1, evidence: ['e2'], el: total }],
    scores: {} as SessionAnalysis['scores'],
    timeline: [
      { id: 'e1', t: 1000, kind: 'action', text: 'Clicked “Apply”' },
      { id: 'e2', t: 2000, kind: 'action', text: 'The total shows $78.40', issue: 'i1' },
      { id: 'e3', t: 9000, kind: 'action', text: 'Clicked “Pay $78.40”', issue: 'i2' },
    ],
    steps: [],
    perf: { fcp: null, lcp: null, cls: 0, slowestInteraction: null, longTasks: 0, longTaskMs: 0 },
    network: { total: 0, failed: 0, slow: 0, endpoints: [] },
    transcript: [],
    shots: [],
    files: [],
    ...over,
  };
}

const finding = (over: Partial<ReportFinding> = {}): ReportFinding => ({
  id: 'f1',
  category: 'bug',
  severity: 'high',
  title: 'BREW10 takes off far too little',
  what: 'The total stays at $78.40.',
  expected: 'A total of $80.80, with shipping of $5.00',
  quote: '',
  evidence: ['e2', 'e3'],
  location: '',
  fix: '',
  steps: [],
  confidence: 'high',
  ...over,
});

describe('a finding’s check', () => {
  it('is read on the element the problem showed on, when it showed: not at a payment made after', () => {
    const a = analysis({ issues: [...analysis().issues, { id: 'i2', kind: 'observed', severity: 'low', title: 'Paid', detail: '', t: 9000, count: 1, evidence: ['e3'], el: pay }] });
    expect(findingCheck(finding(), a)).toMatchObject({ expected: '$80.80', locator: "page.getByTestId('summary-total')", t: 2000 });
  });

  it('when its evidence names no element, is found on one the expected value is named after, nearest the problem', () => {
    const a = analysis({
      issues: [],
      timeline: [{ id: 'e3', t: 9000, kind: 'action', text: 'Clicked “Pay $78.40”' }],
      // The tester pointed at the total while talking, without saying a value.
      transcript: [{ id: 1, start: 4000, end: 5000, text: 'hmm, that looks off', lang: 'en', model: 'm', ms: 1, el: total }],
    });
    expect(findingCheck(finding({ evidence: ['e3'] }), a)).toBeNull();
    expect(namedCheck(finding({ evidence: ['e3'] }), a)).toMatchObject({ expected: '$80.80', locator: "page.getByTestId('summary-total')", t: 4000 });
    // Nothing named like it: no check made up.
    expect(namedCheck(finding({ evidence: ['e3'], expected: 'The page should load faster' }), a)).toBeNull();
  });
});
