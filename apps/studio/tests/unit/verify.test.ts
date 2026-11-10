/**
 * Replay and verify: the same steps played again after a fix, recorded as a
 * session, compared with the first one problem by problem.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_COUNTS, replayReason, type ReplayOutcome, type ReportFinding, type SessionDetail, type SessionMeta, type SessionReport } from '../../shared/session';
import { listenAfter, plannedChecks } from '../../src/core/replay';
import { analyze } from '../../server/sessions/analyze';
import { localReport } from '../../server/sessions/report';
import type { StoredEvent } from '../../server/sessions/store';
import { normKey, screenCheck, verify } from '../../server/sessions/verify';

const T0 = 1_700_000_000_000;
const meta = (id: string): SessionMeta => ({ id, name: id, appUrl: 'http://localhost:5174/', source: 'studio', lang: 'en', startedAt: T0, endedAt: T0 + 20_000, status: 'processing', counts: { ...EMPTY_COUNTS }, audioSeconds: 0, video: null });
const el = (name: string, src: string) => ({ src, name: 'Button', tag: 'button', role: 'button', label: name, text: name, rect: [10, 10, 120, 40] as [number, number, number, number], locator: `page.getByRole('button', { name: '${name}' })` });
const PAY = el('Pay $98.00', 'src/components/OrderSummary.tsx:25:9');
const APPLY = el('Apply', 'src/components/CouponField.tsx:18:9');

let seq = 0;
const at = (ms: number) => T0 + ms;
const page = { seq: ++seq, t: at(100), page: 'p', type: 'page', url: 'http://localhost:5174/#/checkout', title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false };
const click = (ms: number, e: typeof PAY) => ({ seq: ++seq, t: at(ms), page: 'p', type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: e });

/** The first session: the coupon request fails, a script error follows, and Pay does nothing. */
const before = analyze(
  meta('a'),
  [
    page,
    click(1000, APPLY),
    { seq: ++seq, t: at(1100), page: 'p', type: 'net', via: 'fetch', method: 'POST', url: '/api/coupon/123', status: 500, ok: false, ms: 80 },
    { seq: ++seq, t: at(1200), page: 'p', type: 'error', kind: 'error', message: 'Cannot read properties of undefined (reading total) at row 12' },
    click(3000, PAY),
    { seq: ++seq, t: at(3000), page: 'p', type: 'dead', x: 1, y: 1, el: PAY },
  ] as unknown as StoredEvent[],
  [],
  [],
);
const report = localReport(meta('a'), before);

const outcome = (o: Partial<ReplayOutcome> = {}): ReplayOutcome => ({ steps: { total: 2, done: 2 }, checks: [], ...o });

describe('replay and verify', () => {
  it('steps say how a box ended up, and what an element found by its place in the code was', () => {
    const box = { src: 'src/Prefs.tsx:9:5', name: 'input', tag: 'input', role: 'checkbox', label: 'Gift wrap', text: '', rect: [0, 0, 16, 16] as [number, number, number, number], locator: "page.getByLabel('Gift wrap')" };
    const icon = { src: 'src/Toolbar.tsx:12:7', name: 'IconButton', tag: 'button', role: 'button', label: '', text: '', rect: [0, 0, 24, 24] as [number, number, number, number], locator: 'page.locator(\'[data-ds-src="src/Toolbar.tsx:12:7"]\')', shape: 'button.icon#abc' };
    const a = analyze(
      meta('s'),
      [
        page,
        { seq: ++seq, t: at(500), page: 'p', type: 'change', el: box, value: 'on', checked: false },
        click(800, icon as typeof PAY),
      ] as unknown as StoredEvent[],
      [],
      [],
    );
    const [, untick, press] = a.steps;
    expect(untick).toMatchObject({ kind: 'fill', checked: false });
    expect(untick.like).toBeUndefined();
    expect(press).toMatchObject({ kind: 'click', like: { tag: 'button', name: 'IconButton', text: '', shape: 'button.icon#abc' } });
  });

  it('a choice of an option that says the same as another is a step with its value, to be played back by it', () => {
    const list = { src: 'src/Ship.tsx:4:5', name: 'select', tag: 'select', role: 'combobox', label: 'Shipping', text: 'Standard', rect: [0, 0, 120, 24] as [number, number, number, number], locator: "page.getByLabel('Shipping')" };
    const a = analyze(meta('d'), [page, { seq: ++seq, t: at(500), page: 'p', type: 'change', el: list, value: 'Standard', options: ['Standard'], values: ['std-us'], byValue: true }] as unknown as StoredEvent[], [], []);
    expect(a.steps.at(-1)).toMatchObject({ kind: 'fill', select: ['Standard'], values: ['std-us'], byValue: true });
  });

  it('keys a problem the same way across runs: ids and numbers vary, a failing request fails with any status', () => {
    expect(normKey('net:POST /api/coupon/123:500')).toBe(normKey('net:POST /api/coupon/987:502'));
    // A session analysed before ids became placeholders still matches a replay analysed after.
    expect(normKey('net:POST /api/coupon/123:500')).toBe(normKey('net:POST /api/coupon/{id}:500'));
    expect(normKey('con:Order 7 failed at 1729591234567')).toBe(normKey('con:Order {n} failed at {time}'));
    expect(normKey('err:error:Cannot read “total” at row 12')).toBe(normKey('err:error:Cannot read "total" at row 40'));
    expect(normKey('dead:src/a.tsx:1:2')).not.toBe(normKey('dead:src/b.tsx:1:2'));
  });

  it('says what is fixed, what still happens, and what is new', () => {
    // After the fix: the coupon works, but Pay still does nothing, and a new warning appeared.
    const after = analyze(
      meta('b'),
      [
        page,
        click(1000, APPLY),
        { seq: ++seq, t: at(1100), page: 'p', type: 'net', via: 'fetch', method: 'POST', url: '/api/coupon/9', status: 200, ok: true, ms: 70 },
        click(3000, PAY),
        { seq: ++seq, t: at(3000), page: 'p', type: 'dead', x: 1, y: 1, el: PAY },
        { seq: ++seq, t: at(3500), page: 'p', type: 'console', level: 'error', text: 'Each child in a list should have a unique key' },
      ] as unknown as StoredEvent[],
      [],
      [],
    );
    const v = verify(before, report, after, outcome(), 'b');
    const by = (kind: string) => v.issues[before.issues.find((i) => i.kind === kind)!.id].verdict;
    expect(by('network')).toBe('fixed');
    expect(by('error')).toBe('fixed');
    expect(by('frustration')).toBe('still');
    expect(v.fresh.map((f) => f.title)).toEqual([expect.stringContaining('unique key')]);
    // The report's findings follow their issues.
    const deadFinding = report.findings.find((f) => /does nothing/.test(f.title))!;
    expect(v.findings[deadFinding.id].verdict).toBe('still');
    expect(v.findings[deadFinding.id].why).toMatch(/happened again/);
  });

  it('a request the replay never made, or a moment it never reached, can’t be judged', () => {
    const after = analyze(meta('c'), [page, click(1000, APPLY)] as unknown as StoredEvent[], [], []);
    const v = verify(before, report, after, outcome({ steps: { total: 2, done: 1, failed: { i: 1, t: at(3000), description: 'Click the “Pay $98.00” button', reason: 'missing' } } }), 'c');
    const by = (kind: string) => v.issues[before.issues.find((i) => i.kind === kind)!.id];
    expect(by('network').verdict).toBe('unknown');
    expect(by('network').why).toMatch(/didn’t make this request/);
    expect(by('frustration').verdict).toBe('unknown');
    expect(by('frustration').why).toMatch(/stopped before this: Click the “Pay \$98\.00” button \(not found on the page\)/);
  });

  it('a replay that recorded nothing says so, rather than calling everything fixed', () => {
    const nothing = analyze(meta('n'), [] as StoredEvent[], [], []);
    const v = verify(before, report, nothing, outcome(), 'n');
    expect(Object.values(v.issues).map((r) => r.verdict)).toEqual(before.issues.map(() => 'unknown'));
    expect(Object.values(v.issues)[0].why).toMatch(/wasn’t recorded/);
    expect(Object.values(v.findings).every((r) => r.verdict === 'unknown')).toBe(true);
  });

  it('a value the tester said something should show is checked directly', () => {
    const after = analyze(meta('d'), [page] as unknown as StoredEvent[], [], []);
    const f = report.findings[0];
    const ok = verify(before, report, after, outcome({ checks: [{ finding: f.id, expected: '$80.80', actual: 'Total $80.80', ok: true }] }), 'd');
    expect(ok.findings[f.id]).toMatchObject({ verdict: 'fixed', why: 'It shows $80.80 now.' });
    const wrong = verify(before, report, after, outcome({ checks: [{ finding: f.id, expected: '$80.80', actual: 'Total $78.40', ok: false }] }), 'd');
    expect(wrong.findings[f.id]).toMatchObject({ verdict: 'still', why: 'It shows Total $78.40, not $80.80.' });
    // Not found to read: that is no sign it still happens.
    const gone = verify(before, report, after, outcome({ checks: [{ finding: f.id, expected: '$80.80', actual: null, ok: false }] }), 'd');
    expect(gone.findings[f.id]).toMatchObject({ verdict: 'unknown', why: 'What it was said about wasn’t found in the replay, so $80.80 couldn’t be checked.' });
  });
});

describe('a value said while pointing at it in the studio', () => {
  const row = (label: string, value: string, testId: string, line: number) => ({ src: `src/components/OrderSummary.tsx:${line}:9`, name: 'SummaryRow', tag: 'div', role: null, label: `${label} ${value}`, text: `${label} ${value}`, rect: [0, 0, 300, 32] as [number, number, number, number], locator: `page.getByTestId('${testId}')` });
  const DISCOUNT = row('Discount (SAVE20)', '−$19.60', 'summary-discount', 22);
  const TOTAL = row('Total', '$78.40', 'summary-total', 24);
  const point = (ms: number, long: number, target: object) => ({ seq: ++seq, t: at(ms), page: 'studio', type: 'point', el: target, ms: long, via: 'mouse' });
  const said = 'The total looks wrong. Twenty percent should only come off the items, not the shipping. This should show eighty dollars eighty.';
  const segment = { id: 1, start: at(1000), end: at(8000), text: said, lang: 'en', model: 'test', ms: 0 };
  /** The studio's pointing rests on the discount while the sentence starts, then on the total while it says what that should show; the app's own hover stays on the discount. */
  const session = (total: object) =>
    analyze(
      meta('p'),
      [page, point(1000, 4000, DISCOUNT), point(5000, 3000, total), { seq: ++seq, t: at(1000), page: 'p', type: 'hover', el: DISCOUNT, ms: 7000 }, { seq: ++seq, t: at(1000), page: 'p', type: 'hover', el: TOTAL, ms: 400 }] as unknown as StoredEvent[],
      [segment],
      [],
    );

  it('is about what was pointed at while that part was said, named so a replay can find it', () => {
    const a = session(TOTAL);
    const issue = a.issues.find((i) => i.kind === 'said')!;
    expect(issue.el).toMatchObject({ label: 'Total $78.40', locator: "page.getByTestId('summary-total')" });
    expect(a.timeline.find((x) => x.kind === 'speech')?.detail).toContain('Total $78.40');
  });

  it('takes the app’s name for the element when the studio only saw it (a session from before)', () => {
    const { locator: _, ...unnamed } = TOTAL;
    expect(session(unnamed).issues.find((i) => i.kind === 'said')?.el?.locator).toBe("page.getByTestId('summary-total')");
  });

  it('is checked on that element with the value from those words, not the first amount the report names', () => {
    const a = session(TOTAL);
    const issue = a.issues.find((i) => i.kind === 'said')!;
    const speech = a.timeline.find((x) => x.kind === 'speech')!;
    const finding = { id: 'F1', category: 'bug', severity: 'high', title: 'Total after SAVE20 is wrong', what: '', expected: 'Discount is 20% of the items only ($17.20), total $80.80.', quote: said, evidence: [speech.id, issue.id], location: '', fix: '', steps: [], confidence: 'medium' };
    const detail = { meta: meta('p'), analysis: a, report: { findings: [finding] } } as unknown as SessionDetail;
    const checks = plannedChecks(detail);
    expect(checks).toHaveLength(2);
    for (const c of checks) expect(c).toMatchObject({ expected: '$80.80', locator: "page.getByTestId('summary-total')" });
    // Read when that part was said, after the pointer had moved to the total.
    expect(checks[0].t).toBeGreaterThan(at(5000));
  });
});

describe('an amount a finding expects after a step, with nothing said', () => {
  // The coupon session nobody narrated: the report found the wrong discount on the screen after “Apply”.
  const START = ['Order summary', 'Coupon', 'Apply', 'Subtotal', '$86.00', 'Shipping', '$12.00', 'Total', '$98.00', 'Pay $98.00'].join('\n');
  const screen = (lines: string[]) => ['Order summary', 'Coupon', 'SAVE20 applied', 'Remove', 'Subtotal', '$86.00', 'Shipping', '$12.00', ...lines].join('\n');
  const run = (id: string, after: string) =>
    analyze(
      meta(id),
      [
        page,
        { seq: ++seq, t: at(400), page: 'p', type: 'dom', reason: 'start', url: page.url, title: 'Checkout', headings: [], text: START },
        click(1000, APPLY),
        { seq: ++seq, t: at(1800), page: 'p', type: 'dom', reason: 'after', url: page.url, title: 'Checkout', headings: [], text: after },
      ] as unknown as StoredEvent[],
      [],
      [],
    );
  const first = run('a', screen(['Discount (SAVE20)', '−$19.60', 'Total', '$78.40', 'Pay $78.40']));
  const step = first.timeline.find((x) => x.text.startsWith('Clicked'))!;
  const finding = { id: 'F1', category: 'bug', severity: 'high', title: 'SAVE20 takes 20% off shipping too', what: '', expected: 'A discount of 20% of the $86.00 subtotal, $17.20, for a total of $80.80 ($86.00 + $12.00 − $17.20).', quote: '', evidence: [step.id], location: '', fix: '', steps: [], confidence: 'high' } as unknown as ReportFinding;

  it('is fixed when the screen after the same step shows it', () => {
    const fixedRun = run('b', screen(['Discount (SAVE20)', '−$17.20', 'Total', '$80.80', 'Pay $80.80']));
    expect(screenCheck(finding, first, fixedRun)).toMatchObject({ verdict: 'fixed', why: 'After the same step it shows $17.20, $80.80 now.' });
    const v = verify(first, { findings: [finding] } as unknown as SessionReport, fixedRun, outcome(), 'b');
    expect(v.findings.F1.verdict).toBe('fixed');
  });

  it('is still there when it shows other amounts, named', () => {
    expect(screenCheck(finding, first, run('c', screen(['Discount (SAVE20)', '−$19.60', 'Total', '$78.40', 'Pay $78.40'])))).toMatchObject({ verdict: 'still', why: 'After the same step it shows $19.60, $78.40, not $17.20, $80.80.' });
  });

  it('can’t tell when the replay never read the screen after that step, or the finding names no new amount', () => {
    const quiet = analyze(meta('d'), [page, click(1000, APPLY)] as unknown as StoredEvent[], [], []);
    expect(screenCheck(finding, first, quiet)).toBeNull();
    expect(screenCheck({ ...finding, expected: 'The discount should not include the $12.00 shipping.' }, first, run('e', screen(['Total', '$80.80'])))).toBeNull();
  });
});

describe('a replay calls nothing fixed without evidence the steps did what they did', () => {
  const URL = 'http://localhost:5174/#/checkout';
  const dom = (ms: number, reason: string, text: string) => ({ seq: ++seq, t: at(ms), page: 'p', type: 'dom', reason, url: URL, title: 'Checkout', headings: [], text });
  const session = (withChange: boolean, withError: boolean) =>
    analyze(
      meta(withError ? 'first' : 'again'),
      [
        page,
        dom(300, 'start', 'Total\n$98.00'),
        click(1000, APPLY),
        ...(withChange ? [dom(1600, 'after', 'Total\n$78.40')] : []),
        ...(withError ? [{ seq: ++seq, t: at(1200), page: 'p', type: 'error', kind: 'error', message: 'Cannot read total of undefined' }] : []),
      ] as unknown as StoredEvent[],
      [],
      [],
    );

  it('a problem gone after a step that changed nothing on screen this time (it did the first time) can’t be judged', () => {
    const first = session(true, true);
    const error = first.issues.find((i) => i.kind === 'error')!;
    // The replay pressed Apply, and nothing happened: no new total, no error. Not “fixed”: the step did nothing.
    const idle = verify(first, null, session(false, false), outcome({ steps: { total: 1, done: 1 } }), 'r1');
    expect(idle.issues[error.id]).toMatchObject({ verdict: 'unknown' });
    expect(idle.issues[error.id].why).toMatch(/changed nothing on screen in the replay/);
    // The same step changed the screen in the replay too, and the error didn't come: fixed.
    const worked = verify(first, null, session(true, false), outcome({ steps: { total: 1, done: 1 } }), 'r2');
    expect(worked.issues[error.id]).toMatchObject({ verdict: 'fixed' });
  });

  it('a button that did nothing because it was disabled, and still is, is still a problem; anything after it can’t be judged', () => {
    const dead = before.issues.find((i) => i.key?.startsWith('dead:'))!;
    const pay = before.steps.findIndex((s) => s.description.includes('Pay'));
    const v = verify(before, report, before, outcome({ steps: { total: 2, done: pay, failed: { i: pay, t: before.steps[pay].t, description: before.steps[pay].description, reason: 'disabled' } } }), 'r3');
    expect(v.issues[dead.id]).toMatchObject({ verdict: 'still' });
    expect(v.issues[dead.id].why).toMatch(/still disabled/);
  });
});

describe('a replay calls nothing fixed that it couldn’t have seen', () => {
  const save = el('Save profile', 'src/Profile.tsx:9:5');
  const late = { seq: ++seq, t: at(4000), page: 'p', type: 'error', kind: 'rejection', message: 'Cannot read properties of undefined (reading map)' };
  const first = (state?: string, events: object[] = [late]) => analyze({ ...meta('l'), endedAt: T0 + 6000 }, [{ ...page, ...(state ? { state } : {}) }, click(1000, save), ...events] as unknown as StoredEvent[], [], []);
  const again = (end: number, state?: string) => analyze({ ...meta('r'), endedAt: T0 + end }, [{ ...page, ...(state ? { state } : {}) }, click(1000, save)] as unknown as StoredEvent[], [], []);
  const verdictOf = (a: ReturnType<typeof first>, r: ReturnType<typeof again>) => Object.values(verify(a, null, r, outcome({ steps: { total: 1, done: 1 } }), 'r').issues)[0];

  it('an error that came 3 s after its step is not fixed when the replay stopped listening 1.2 s after it', () => {
    const v = verdictOf(first(), again(2200));
    expect(v.verdict).toBe('unknown');
    expect(v.why).toBe('It came 3.0 s after its step the first time; the replay listened for 1.2 s, so it can’t tell.');
    // Listened long enough: gone is gone.
    expect(verdictOf(first(), again(6000)).verdict).toBe('fixed');
  });

  it('the replay listens after a step as long as what followed it took the first time, plus a margin, within reason', () => {
    expect(listenAfter([{ t: 1000 }, { t: 9000 }], [{ t: 4000 }])).toEqual([4500, 0]);
    expect(listenAfter([{ t: 1000 }], [{ t: 60_000 }])).toEqual([15_000]);
    expect(listenAfter([{ t: 1000 }], [])).toEqual([0]);
  });

  it('a problem that didn’t come again when the app started from other saved data is “couldn’t confirm”, not fixed', () => {
    const v = verdictOf(first('3:abc'), again(6000, '4:def'));
    expect(v.verdict).toBe('unknown');
    expect(v.why).toMatch(/^Couldn’t confirm: the app started from different saved data than when you recorded/);
    expect(verdictOf(first('3:abc'), again(6000, '3:abc')).verdict).toBe('fixed');
  });

  it('a step that matches several elements now stops the replay, with why', () => {
    expect(replayReason('ambiguous', 'en')).toBe('it matches several elements now, so the replay didn’t guess which one');
  });
});
