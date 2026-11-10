/**
 * What a test is written from: every step and check it was given, or a refusal that says which one is wrong. Nothing
 * is cut short (a test written from part of them would pass without checking the rest), and nothing malformed reaches
 * the file.
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../server/http';
import { MAX_CHECKS, MAX_STEPS, validChecks, validSteps } from '../../server/tests/validate';

const click = (i: number) => ({ kind: 'click', locator: `page.getByRole('button', { name: 'Item ${i}' })`, description: `Click Item ${i}` });
const check = (over: Record<string, unknown> = {}) => ({ locator: "page.getByTestId('summary-total')", description: 'the total', expected: '$80.80', actual: '$78.40', ...over });

/** The refusal a call makes: its status and what it says. */
function refusal(run: () => unknown): { status: number; message: string } {
  try {
    run();
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error('It was accepted');
}

describe('a test’s steps', () => {
  it('are all kept, up to the most a test may have', () => {
    const steps = Array.from({ length: MAX_STEPS }, (_, i) => click(i));
    expect(validSteps(steps)).toHaveLength(MAX_STEPS);
    expect(validSteps(undefined)).toEqual([]);
  });

  it('past that, nothing is written, and the refusal says how many and what to do', () => {
    const r = refusal(() => validSteps(Array.from({ length: MAX_STEPS + 1 }, (_, i) => click(i))));
    expect(r).toEqual({ status: 400, message: 'A test can have at most 1,000 steps, and this one has 1,001: nothing was written. Split it into shorter tests.' });
  });

  it('keep only what a step is, whatever else was sent', () => {
    const [s] = validSteps([{ ...click(1), script: 'alert(1)', value: 'ignored for a click', checked: true }]);
    expect(s).toEqual(click(1));
    const [f] = validSteps([{ kind: 'fill', locator: "page.getByLabel('Size')", value: '', select: ['Large'], values: ['l'], byValue: true, description: 'Choose “Large”', extra: 1 }]);
    expect(f).toEqual({ kind: 'fill', locator: "page.getByLabel('Size')", value: '', select: ['Large'], values: ['l'], byValue: true, description: 'Choose “Large”' });
    // An absent field may be sent as null.
    expect(validSteps([{ kind: 'note', description: 'Looks off', locator: null, url: null }])).toEqual([{ kind: 'note', description: 'Looks off' }]);
  });

  it('a malformed one is refused by its number, saying what is wrong', () => {
    const cases: [unknown, string][] = [
      [null, 'Step 2 isn’t a step'],
      [[click(9)], 'Step 2 isn’t a step'],
      [{ kind: 'scroll', description: 'Scroll down' }, 'Step 2 is “scroll”, which a test can’t do: a step is one of click, fill, press, goto, note, url, hover, drag, upload, missed.'],
      [{ kind: 'fill', value: 'x', description: 'Type x' }, 'Step 2 (fill) names no element to fill (locator).'],
      [{ kind: 'click', locator: "page.getByText('x')" }, 'Step 2 says nothing about what it does (description).'],
      [{ kind: 'fill', locator: "page.getByLabel('Name')", value: { text: 'Ann' }, description: 'Type' }, 'Step 2: value must be text, not {"text":"Ann"}.'],
      [{ kind: 'fill', locator: "page.getByLabel('Name')", value: 42, description: 'Type' }, 'Step 2: value must be text, not 42.'],
      [{ kind: 'fill', locator: "page.getByLabel('Size')", select: 'Large', description: 'Choose' }, 'Step 2: select must be a list of texts.'],
      [{ kind: 'fill', locator: "page.getByLabel('Agree')", checked: 'yes', description: 'Tick' }, 'Step 2: checked must be true or false, not yes.'],
      [{ kind: 'click', locator: "page.evaluate(() => fetch('/x'))", description: 'Click' }, 'Step 2: “page.evaluate(() => fetch(\'/x\'))” isn’t a locator a test can use.'],
      [{ kind: 'goto', description: 'Open the cart' }, 'Step 2 (goto) names no address (url).'],
      [{ kind: 'press', locator: "page.getByLabel('Search')", key: ['Enter'], description: 'Press' }, 'Step 2: key must be text, not ["Enter"].'],
      [{ kind: 'fill', locator: "page.getByLabel('Size')", select: ['Large'], byValue: 'yes', description: 'Choose' }, 'Step 2: byValue must be true or false, not yes.'],
      [{ kind: 'fill', locator: "page.getByLabel('Size')", select: ['Large'], byValue: true, description: 'Choose' }, 'Step 2 chooses by value, and names no values.'],
    ];
    for (const [bad, said] of cases) {
      const r = refusal(() => validSteps([click(1), bad]));
      expect(r.status, said).toBe(400);
      expect(r.message, said).toContain(said);
    }
    expect(refusal(() => validSteps({ length: 3 })).message).toBe('steps must be a list of steps.');
  });

  it('a value as long as what was typed is kept whole', () => {
    const value = 'x'.repeat(100_000);
    expect(validSteps([{ kind: 'fill', locator: "page.getByLabel('Notes')", value, description: 'Type into the notes' }])[0].value).toBe(value);
  });
});

describe('a test’s checks', () => {
  it('are all kept, past twenty: a check that fails is never one that was left out', () => {
    const checks = Array.from({ length: 21 }, (_, i) => check({ expected: `$${i}.00` }));
    const kept = validChecks(checks, 0);
    expect(kept).toHaveLength(21);
    expect(kept[20]).toEqual({ locator: "page.getByTestId('summary-total')", description: 'the total', expected: '$20.00', actual: '$78.40' });
    expect(validChecks(Array.from({ length: MAX_CHECKS }, () => check()), 0)).toHaveLength(MAX_CHECKS);
  });

  it('past the most a test may have, nothing is written', () => {
    const r = refusal(() => validChecks(Array.from({ length: MAX_CHECKS + 1 }, () => check()), 0));
    expect(r).toEqual({ status: 400, message: 'A test can have at most 100 checks, and this one has 101: nothing was written. Split it into shorter tests.' });
  });

  it('a check that could never fail, or that can’t be written, is refused by its number', () => {
    const cases: [unknown, string][] = [
      [null, 'Check 2 isn’t a check'],
      [check({ expected: '' }), 'Check 2 says nothing it should show (expected).'],
      [check({ expected: '   ' }), 'Check 2 says nothing it should show (expected).'],
      [check({ expected: 80.8 }), 'Check 2: expected must be text, not 80.8.'],
      [check({ locator: undefined }), 'Check 2 names no element to check (locator).'],
      [check({ locator: 'document.body' }), 'Check 2: “document.body” isn’t a locator a test can use.'],
      [check({ description: '' }), 'Check 2 says nothing about what it checks (description).'],
      [check({ field: 'color' }), 'Check 2 is about “color”, which a check can’t read'],
      [check({ field: 'checked', expected: 'yes' }), 'Check 2 is about whether it is checked, so it should be “checked” or “not checked”, not “yes”.'],
      [check({ after: -1 }), 'Check 2: after must be how many steps come before it (a whole number), not -1.'],
      [check({ after: 1.5 }), 'Check 2: after must be how many steps come before it (a whole number), not 1.5.'],
      [check({ after: 4 }), 'Check 2 comes after step 4, and the test has 3.'],
    ];
    for (const [bad, said] of cases) {
      const r = refusal(() => validChecks([check(), bad], 3));
      expect(r.status, said).toBe(400);
      expect(r.message, said).toContain(said);
    }
    expect(refusal(() => validChecks([], 0)).message).toBe('Say what you expected first');
    expect(refusal(() => validChecks(undefined, 0)).message).toBe('Say what you expected first');
  });

  it('keeps where each was said, what it is about, and what the element showed (empty when not said)', () => {
    expect(validChecks([check({ after: 3, field: 'value', actual: undefined })], 3)).toEqual([{ locator: "page.getByTestId('summary-total')", description: 'the total', expected: '$80.80', actual: '', field: 'value', after: 3 }]);
    expect(validChecks([check({ field: 'checked', expected: 'not checked', after: null })], 0)[0]).toMatchObject({ field: 'checked', expected: 'not checked' });
  });
});
