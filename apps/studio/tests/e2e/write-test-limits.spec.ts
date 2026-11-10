/**
 * A long test is written whole: past a hundred steps and twenty checks, every one of them is in the file and runs,
 * so a check that fails late fails the run, and a value too long for a pattern is still checked. Past what a test may
 * hold, or malformed, nothing is written and the refusal says why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { TestRunResult } from '../../shared/api';
import { E2E_SHOP, resetAll, STUDIO } from './helpers';

test.beforeEach(() => resetAll());

const EMAIL = "page.getByLabel('Email')";
/** Longer than a value a test checks as a pattern. */
const LONG = `${'a'.repeat(1500)}@example.com`;
const STEPS = [
  ...Array.from({ length: 100 }, (_, i) => ({ kind: 'fill', locator: EMAIL, value: `user${i}@example.com`, description: `Type user${i}@example.com into the Email field` })),
  { kind: 'fill', locator: EMAIL, value: LONG, description: 'Type a long address into the Email field' },
];
const field = (expected: string) => ({ locator: EMAIL, description: 'the Email field', expected, actual: '', field: 'value', after: STEPS.length });
/** Twenty checks that hold (one of them on the whole long value), then `last`. */
const checks = (last: string) => [...Array.from({ length: 19 }, () => field('@example.com')), field(LONG), field(last)];

async function post<T>(url: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${STUDIO}/api${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
}

test('a test past a hundred steps and twenty checks is written and run whole: its twenty-first check can fail it', async () => {
  test.setTimeout(180_000);
  const failing = await post<{ path: string; code: string }>('/tests/generate', { name: 'Long account form', startUrl: '/#/account', steps: STEPS, expectations: checks('nobody@example.org') });
  expect(failing.status).toBe(200);
  expect(failing.json.code).toContain("await test.step('[102] Type a long address into the Email field'");
  expect(failing.json.code).toContain("await test.step('[check 21] The Email field should show nobody@example.org'");
  expect(failing.json.code).toContain(`await expect.poll(() => ${EMAIL}.inputValue()).toContain('${LONG}');`);
  const failed = (await post<TestRunResult>('/tests/run', { path: failing.json.path })).json;
  expect(failed).toMatchObject({ status: 'failed', failedAt: 'check', expected: 'nobody@example.org', counts: { steps: 102, checks: 21, stepsPassed: 102, checksPassed: 20 } });
  expect(failed.verified).toBeFalsy();

  // (The end of the address alone would no longer do: “a@example.com” is not the value, only the end of a longer word.)
  const passing = await post<{ path: string }>('/tests/generate', { name: 'Long account form passing', startUrl: '/#/account', steps: STEPS, expectations: checks(LONG) });
  const passed = (await post<TestRunResult>('/tests/run', { path: passing.json.path })).json;
  expect(passed).toMatchObject({ status: 'passed', verified: true, counts: { steps: 102, checks: 21, stepsPassed: 102, checksPassed: 21 } });
});

test('past what a test may hold, or malformed, nothing is written and the refusal says why', async () => {
  const dir = path.join(E2E_SHOP, 'tests/saywright');
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
  const before = files();
  const one = [field('@example.com')].map((c) => ({ ...c, after: 1 }));
  const cases: [unknown, string][] = [
    [{ steps: Array.from({ length: 1001 }, (_, i) => STEPS[i % 100]), expectations: checks('x') }, 'A test can have at most 1,000 steps, and this one has 1,001: nothing was written. Split it into shorter tests.'],
    [{ steps: STEPS, expectations: Array.from({ length: 101 }, () => field('@example.com')) }, 'A test can have at most 100 checks, and this one has 101: nothing was written. Split it into shorter tests.'],
    [{ steps: [null], expectations: one }, 'Step 1 isn’t a step'],
    [{ steps: [{ kind: 'fill', value: 'x', description: 'Type x' }], expectations: one }, 'Step 1 (fill) names no element to fill (locator).'],
    [{ steps: [{ kind: 'fill', locator: EMAIL, value: { text: 'x' }, description: 'Type x' }], expectations: one }, 'Step 1: value must be text, not {"text":"x"}.'],
    [{ steps: [STEPS[0]], expectations: [field('@example.com')] }, 'Check 1 comes after step 101, and the test has 1.'],
  ];
  for (const [body, said] of cases) {
    const res = await post<{ error: string }>('/tests/generate', body);
    expect(res.status, said).toBe(400);
    expect(res.json.error, said).toContain(said);
  }
  expect(files()).toEqual(before);
});
