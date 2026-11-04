import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { jsString } from '@saywright/vite/protocol';
import { generateSpec, safeLocator, secretsOf, urlPattern, writeSpec } from '../../server/tests/generate';
import { focusOn, judge, marksOf, parseFailure, sweepRuns } from '../../server/tests/run';
import { tempShop } from './helpers';

const input = {
  startUrl: 'http://localhost:5174/#/checkout',
  steps: [
    { kind: 'fill' as const, locator: "page.getByTestId('coupon-input')", value: 'SAVE20', description: 'Type SAVE20' },
    { kind: 'click' as const, locator: "page.getByTestId('coupon-apply')", description: 'Click Apply' },
    { kind: 'note' as const, description: 'Note: the discount looks too big' },
  ],
  expectations: [{ locator: "page.getByTestId('summary-total')", description: 'the total', expected: '$80.80', actual: '$78.40' }],
};

describe('generateSpec', () => {
  it('writes a readable Playwright test from the narration, each step and check a numbered test.step', () => {
    const code = generateSpec(input, new Date('2026-10-13T00:00:00Z'));
    expect(code).toContain("test('total should show $80.80', async ({ page }) => {");
    expect(code).toContain("  await test.step('[1] Open /#/checkout', async () => {\n    await page.goto('/#/checkout');\n  });");
    expect(code).toContain("  await test.step('[2] Type SAVE20', async () => {\n    await page.getByTestId('coupon-input').fill('SAVE20');\n  });");
    expect(code).toContain("  await test.step('[3] Click Apply', async () => {");
    expect(code).toContain('// Note: the discount looks too big');
    expect(code).toContain("  await test.step('[check 1] The total should show $80.80', async () => {");
    expect(code).toContain("await expect(page.getByTestId('summary-total')).toContainText('$80.80');");
    // No secrets: no helper that reads the environment.
    expect(code).not.toContain('process.env');
  });

  it('puts each check where it was said: after the steps before it, before the steps after it', () => {
    const code = generateSpec({
      startUrl: 'http://localhost:5174/',
      steps: [
        { kind: 'fill', locator: "page.getByTestId('coupon-input')", value: 'SAVE20', description: 'Type SAVE20' },
        { kind: 'click', locator: "page.getByTestId('coupon-apply')", description: 'Click Apply' },
        { kind: 'click', locator: "page.getByRole('link', { name: 'Checkout' })", description: 'Click Checkout' },
        { kind: 'url', url: 'http://localhost:5174/checkout', description: 'The page is /checkout' },
      ],
      expectations: [
        { locator: "page.getByTestId('summary-total')", description: 'the total', expected: '$80.80', actual: '$78.40', after: 2 },
        { locator: "page.getByRole('heading')", description: 'the heading', expected: 'Checkout', actual: 'Cart' },
      ],
    });
    const at = (s: string) => code.indexOf(s);
    expect(at('[check 1] The total')).toBeGreaterThan(at('[3] Click Apply'));
    expect(at('[check 1] The total')).toBeLessThan(at('[4] Click Checkout'));
    // An older studio's check, with no place: after every step.
    expect(at('[check 2] The heading')).toBeGreaterThan(at('[5] The page is /checkout'));
    // A step that navigates is waited for: the next one runs on the page it led to.
    expect(code).toContain("await expect(page).toHaveURL(new RegExp('^[a-z]+://[^/]+/checkout/?(?:[?#]|$)'));");
  });

  it('never writes a secret into the test: it types it from the environment, and says which variable', () => {
    const code = generateSpec({
      startUrl: 'http://localhost:5174/login',
      steps: [
        { kind: 'fill', locator: "page.getByLabel('Email')", value: 'me@example.com', description: 'Type “me@example.com” into the “Email” field' },
        // Whatever an older plugin put in `value`, a secret step writes only its name.
        { kind: 'fill', locator: "page.getByLabel('Password')", value: 'hunter2', secret: 'PASSWORD', description: 'Type ••• into the “Password” field' },
        { kind: 'fill', locator: "page.getByLabel('Confirm password')", value: '', secret: 'password', description: 'Type ••• into the “Confirm password” field' },
      ],
      expectations: [{ locator: "page.getByRole('heading')", description: 'the heading', expected: 'Welcome', actual: 'Sign in' }],
    });
    expect(code).not.toContain('hunter2');
    expect(code).toContain("await page.getByLabel('Password').fill(secret('PASSWORD'));");
    expect(code).toContain("await page.getByLabel('Confirm password').fill(secret('PASSWORD'));");
    expect(code).toContain('// Secrets are never written here: it types PASSWORD from SAYWRIGHT_SECRET_PASSWORD');
    expect(code).toContain('const value = process.env[`SAYWRIGHT_SECRET_${name}`];');
    expect(code).toContain('if (!value) throw new Error(');
    expect(secretsOf(code)).toEqual(['PASSWORD']);
    // It still parses, as a module with the helper, the import and the test.
    expect(parse(code, { sourceType: 'module', plugins: ['typescript'] }).program.body).toHaveLength(3);
  });

  it('chooses options in a list with selectOption, never fill: by what they say, by value when that has numbers, several at once', () => {
    const code = generateSpec({
      startUrl: 'http://localhost:5174/',
      steps: [
        { kind: 'fill', locator: "page.getByLabel('Shipping')", value: 'exp', select: ['Express'], values: ['exp'], description: 'Choose “Express” in the “Shipping” menu' },
        { kind: 'fill', locator: "page.getByLabel('Plan')", value: 'pro', select: ['Pro ($20/month)'], values: ['pro'], description: 'Choose “Pro ($20/month)”' },
        { kind: 'fill', locator: "page.getByLabel('Toppings')", value: 'ham', select: ['Ham', 'Olives'], values: ['ham', 'olives'], description: 'Choose “Ham”, “Olives”' },
        // An older studio's session: the choice by what it says, no values.
        { kind: 'fill', locator: "page.getByLabel('Size')", value: 'Large', select: ['Large'], description: 'Set the “Size” menu' },
      ],
      expectations: [{ locator: "page.getByLabel('Shipping')", description: 'the shipping menu', expected: 'Express', actual: 'Express', field: 'select' }],
    });
    expect(code).not.toContain(".fill('exp')");
    expect(code).toContain("await page.getByLabel('Shipping').selectOption({ label: 'Express' });");
    expect(code).toContain("await page.getByLabel('Plan').selectOption('pro');");
    expect(code).toContain("await page.getByLabel('Toppings').selectOption([{ label: 'Ham' }, { label: 'Olives' }]);");
    expect(code).toContain("await page.getByLabel('Size').selectOption({ label: 'Large' });");
    // One of the options chosen says it, however many the list takes.
    expect(code).toContain("await expect(page.getByLabel('Shipping').locator('option:checked')).toContainText(['Express']);");
    expect(code).toContain("test('shipping menu should have Express chosen'");
  });

  it('checks a field by its value, not its text', () => {
    const code = generateSpec({ ...input, expectations: [{ locator: "page.getByLabel('Quantity')", description: 'the quantity', expected: '2.5', actual: '1', field: 'value' }] });
    expect(code).toContain("await expect(page.getByLabel('Quantity')).toHaveValue(new RegExp('2\\\\.5'));");
  });

  it('checks or unchecks a box, rather than filling it', () => {
    const code = generateSpec({
      ...input,
      steps: [
        { kind: 'fill', locator: "page.getByLabel('Gift wrap')", value: 'on', checked: true, description: 'Tick gift wrap' },
        { kind: 'fill', locator: "page.getByLabel('Newsletter')", value: 'on', checked: false, description: 'Untick the newsletter' },
      ],
    });
    expect(code).toContain("await page.getByLabel('Gift wrap').check();");
    expect(code).toContain("await page.getByLabel('Newsletter').uncheck();");
  });

  it('checks whether a box is checked, not its text', () => {
    const code = generateSpec({
      ...input,
      expectations: [
        { locator: "page.getByRole('checkbox', { name: 'Remember me' })", description: 'the “Remember me” checkbox', expected: 'checked', actual: 'not checked', field: 'checked' },
        { locator: "page.getByLabel('Newsletter')", description: 'the “Newsletter” field', expected: 'not checked', actual: 'checked', field: 'checked' },
      ],
    });
    expect(code).toContain("await expect(page.getByRole('checkbox', { name: 'Remember me' })).toBeChecked();");
    expect(code).toContain("await expect(page.getByLabel('Newsletter')).not.toBeChecked();");
    expect(code).toContain("'[check 1] The “Remember me” checkbox should be checked'");
    expect(code).toContain('// You said the “Remember me” checkbox should be checked (it was not checked).');
    expect(code).toContain("'[check 2] The “Newsletter” field should not be checked'");
    expect(code).not.toContain("toContainText('checked')");
  });

  it('finds a name or a text with its numbers left open, as a pattern nothing in runs', () => {
    const steps = [
      { kind: 'click' as const, locator: "page.getByRole('button', { name: /^Pay \\$\\d[\\d.,]* and subscribe$/ })", description: 'Click “Pay $91.57 and subscribe”' },
      { kind: 'click' as const, locator: "page.getByRole('row').filter({ hasText: 'You pay' }).locator('td')", description: 'Click the cell for “You pay”' },
    ];
    for (const st of steps) expect(safeLocator(st.locator)).toBe(st.locator);
    const code = generateSpec({ ...input, steps, expectations: [{ locator: 'page.getByText(/^Like this portfolio \\(\\d[\\d.,]*\\)$/)', description: '“Like this portfolio (1)”', expected: 'Like this portfolio (2)', actual: 'Like this portfolio (1)' }] });
    expect(code).toContain("await page.getByRole('button', { name: /^Pay \\$\\d[\\d.,]* and subscribe$/ }).click();");
    expect(code).toContain("await expect(page.getByText(/^Like this portfolio \\(\\d[\\d.,]*\\)$/)).toContainText('Like this portfolio (2)');");
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const patterns: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const node = n as { type?: string; pattern?: string };
      if (node.type === 'RegExpLiteral' && node.pattern) patterns.push(node.pattern);
      for (const v of Object.values(n)) walk(v);
    };
    walk(ast.program);
    expect(patterns).toEqual(['^Pay \\$\\d[\\d.,]* and subscribe$', '^Like this portfolio \\(\\d[\\d.,]*\\)$']);
    // A pattern is one token: whatever follows its end, or a flag that makes it stateful, is refused.
    for (const bad of [
      "page.getByText(/a/); process.exit(1)",
      'page.getByText(/a/.source)',
      'page.getByText(/a/g)',
      'page.getByText(/*/)',
      'page.getByText(//)',
      'page.getByText(/a\n/)',
      'page.getByText(/a/ + process.exit(2))',
      "page.getByText(/[/]); process.exit(3); //]/)",
      "page.getByRole('button', { name: /a/, x: process })",
    ]) {
      expect(() => safeLocator(bad), bad).toThrow();
    }
    // A slash inside a class or escaped is part of it.
    expect(safeLocator('page.getByText(/^a[/]b\\/c$/)')).toBe('page.getByText(/^a[/]b\\/c$/)');
  });

  it('rejects anything that is not a locator expression', () => {
    expect(() => safeLocator("page.getByRole('x'); require('fs')")).toThrow();
    expect(() => safeLocator('fetch("x")')).toThrow();
    // A line break would end the line: what follows it would run as code.
    expect(() => safeLocator("page.getByText('a\r' + process.exit(3) + '')")).toThrow();
    // Only what locators call, with only strings, numbers and flat objects of them.
    for (const bad of ["page.getByRole('button').evaluate('x')", 'page.getByRole(x)', "page.locator('a')['click']()", 'page.getByText(`a`)', "page.filter({ hasText: 'a' })", "page.getByRole('button', { name: { a: 'b' } })", "page.getByRole('button').nth(1)."]) {
      expect(() => safeLocator(bad)).toThrow();
    }
  });

  it('takes a control found by its card, whatever the card says', () => {
    const title = "Import duty; it's `free`, require nothing";
    const chain = `page.getByRole('article').filter({ hasText: ${jsString(title)} }).getByRole('button', { name: 'Add to cart' })`;
    expect(safeLocator(chain)).toBe(chain);
    const code = generateSpec({ ...input, steps: [{ kind: 'click', locator: chain, description: 'Click “Add to cart” for the card' }] });
    expect(code).toContain(`await ${chain}.click();`);
    const strings: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const node = n as { type?: string; value?: unknown };
      if (node.type === 'StringLiteral' && typeof node.value === 'string') strings.push(node.value);
      for (const v of Object.values(n)) walk(v);
    };
    walk(parse(code, { sourceType: 'module', plugins: ['typescript'] }).program);
    expect(strings).toContain(title);
  });

  it('keeps any page text inside its strings and comments: the test still parses, and nothing else runs', () => {
    const hostile = ['Email\nrequire(`fs`)', 'a\rprocess.exit(3)', 'b\u2028process.exit(4)', 'c\u2029process.exit(5)', "it's */ done", 'back\\slash', '${x} `y`'];
    const code = generateSpec({
      name: hostile.join(' '),
      startUrl: 'http://localhost:5174/#/checkout',
      // Locators hold page text too (written by the bridge with the same escaping); words like require stay refused there.
      steps: hostile.flatMap((h, i) => [
        { kind: 'fill' as const, locator: `page.getByPlaceholder(${jsString(`Field\r${i}\u2028`)})`, value: h, description: h },
        { kind: 'note' as const, description: h },
      ]),
      expectations: hostile.map((h, i) => ({ locator: `page.getByText(${jsString(`Total\n${i}\u2029`)})`, description: `the “${h}” field`, expected: h, actual: h })),
    });
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    // The import and the test, and in the test only the steps and checks, each one statement.
    expect(ast.program.body).toHaveLength(2);
    const body = (ast.program.body[1] as unknown as { expression: { arguments: { body: { body: unknown[] } }[] } }).expression.arguments[1].body.body;
    expect(body).toHaveLength(1 + hostile.length * 2);
    // The text is still what the page said, and no `process` is ever reached as code.
    const strings: string[] = [];
    const names: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const node = n as { type?: string; value?: unknown; name?: string };
      if (node.type === 'StringLiteral' && typeof node.value === 'string') strings.push(node.value);
      if (node.type === 'Identifier' && node.name) names.push(node.name);
      for (const v of Object.values(n)) walk(v);
    };
    walk(ast.program);
    for (const h of hostile) expect(strings).toContain(h);
    expect(names).not.toContain('process');
    expect(names).not.toContain('require');
  });

  it('written again for the same test, it takes its own earlier file’s place, never anyone else’s', () => {
    const p = tempShop();
    const first = writeSpec(p, input);
    const again = writeSpec(p, { ...input, expectations: [...input.expectations, { ...input.expectations[0], expected: '$1.00' }] }, first);
    expect(again.path).toBe(first.path);
    expect(p.read(first.path)).toBe(again.code);
    // Changed since by someone else: kept, and the new version goes beside it.
    p.write(first.path, `${again.code}\n// mine`);
    const third = writeSpec(p, input, again);
    expect(third.path).not.toBe(first.path);
    // Nothing outside the tests folder is ever written over.
    expect(writeSpec(p, input, { path: 'src/main.tsx', code: p.read('src/main.tsx') }).path).toMatch(/^tests\/saywright\//);
  });

  it('never overwrites an existing test file', () => {
    const p = tempShop();
    const a = writeSpec(p, input);
    const b = writeSpec(p, input);
    expect(a.path).toBe('tests/saywright/total-should-show-80-80.spec.ts');
    expect(b.path).toBe('tests/saywright/total-should-show-80-80-2.spec.ts');
  });
});

describe('urlPattern', () => {
  it('matches the same page on another run (ids and numbers change), and not other pages', () => {
    const cases: [string, string[], string[]][] = [
      ['http://localhost:5173/', ['http://localhost:5173/', 'http://localhost:5173/?x=1', 'http://127.0.0.1:4000/#top'], ['http://localhost:5173/checkout']],
      ['http://localhost:5173/checkout', ['http://localhost:5173/checkout', 'http://localhost:5173/checkout/', 'http://x:1/checkout?step=2'], ['http://localhost:5173/checkout/done', 'http://localhost:5173/', 'http://localhost:5173/checkoutx']],
      ['http://localhost:5173/orders/123', ['http://localhost:5173/orders/456', 'http://localhost:5173/orders/abc-1234567890abcdef'], ['http://localhost:5173/orders', 'http://localhost:5173/orders/1/items']],
      ['http://localhost:5173/u/550e8400-e29b-41d4-a716-446655440000/edit', ['http://localhost:5173/u/0000aaaa-e29b-41d4-a716-446655440000/edit'], ['http://localhost:5173/u/1/settings']],
      ['http://localhost:5174/#/checkout', ['http://localhost:5174/#/checkout', 'http://localhost:5174/#/checkout?x=1'], ['http://localhost:5174/#/shop', 'http://localhost:5174/checkout']],
    ];
    for (const [url, same, other] of cases) {
      const re = new RegExp(urlPattern(url));
      for (const u of same) expect(re.test(u), `${url} ~ ${u}`).toBe(true);
      for (const u of other) expect(re.test(u), `${url} !~ ${u}`).toBe(false);
    }
  });
});

describe('parseFailure', () => {
  it('pulls expected and received values out of Playwright errors', () => {
    const msg = 'Error: expect(locator).toContainText(expected) failed\n\nLocator: getByTestId(\'summary-total\')\nExpected substring: "$80.80"\nReceived string:    "Total$78.40"\n';
    expect(parseFailure(msg)).toEqual({ expected: '$80.80', received: '$78.40' });
  });

  it('shows the part of a long received text that looks like the expectation', () => {
    expect(focusOn('Total$78.40', '$80.80')).toBe('$78.40');
    expect(focusOn('Shipping 12 days', '3 days')).toBe('12 days');
    expect(focusOn('Free shipping', 'Paid shipping')).toBe('Free shipping');
    expect(focusOn(undefined, '$1')).toBeUndefined();
  });
});

describe('what a run proves', () => {
  const mask = (t: string | undefined) => t;
  const marks = ['1', '2', '3', 'check 1'];
  const step = (title: string, error?: string) => ({ title, ...(error ? { error: { message: error } } : {}) });
  const all = [step('[1] Open /'), step('[2] Type SAVE20'), step('[3] Click Apply'), step('[check 1] The total should show $80.80')];

  it('a pass is verified only when every step and check reported running, on the first try', () => {
    expect(judge({ status: 'passed', duration: 1, steps: all }, marks, mask)).toMatchObject({ status: 'passed', verified: true, counts: { steps: 3, checks: 1, stepsPassed: 3, checksPassed: 1 } });
    // A check that never ran (an edited test, a step skipped): not verified, and it says which.
    const missing = judge({ status: 'passed', duration: 1, steps: all.slice(0, 3) }, marks, mask);
    expect(missing).toMatchObject({ status: 'passed', verified: false });
    expect(missing.unverified).toMatch(/\[check 1\]/);
    // Passed only when retried.
    expect(judge({ status: 'passed', retry: 1, duration: 1, steps: all }, marks, mask)).toMatchObject({ verified: false, unverified: 'The test passed only when tried again.' });
    // No checks at all: its steps ran, nothing was checked.
    expect(judge({ status: 'passed', duration: 1, steps: all.slice(0, 3) }, ['1', '2', '3'], mask)).toMatchObject({ verified: false });
    // An older test, with no numbered steps: a pass shows less.
    expect(judge({ status: 'passed', duration: 1, steps: [] }, [], mask).unverified).toMatch(/no numbered steps/);
  });

  it('a skipped test proves nothing; a failure says whether it was at a check (the bug shows) or a step before', () => {
    expect(judge({ status: 'skipped', duration: 0, steps: [] }, marks, mask)).toMatchObject({ status: 'error', message: 'The test was skipped, so it shows nothing.' });
    const atCheck = judge({ status: 'failed', duration: 1, steps: [...all.slice(0, 3), step('[check 1] The total should show $80.80', 'Expected substring: "$80.80"\nReceived string: "$78.40"')] }, marks, mask);
    expect(atCheck).toMatchObject({ status: 'failed', failedAt: 'check' });
    const atStep = judge({ status: 'failed', duration: 1, steps: [all[0], step('[2] Type SAVE20', 'Timeout 15000ms exceeded waiting for getByTestId(\'coupon-input\')')] }, marks, mask);
    expect(atStep).toMatchObject({ status: 'failed', failedAt: 'step', counts: { stepsPassed: 1, checksPassed: 0 } });
  });

  it('knows a generated test’s steps and checks from its code, and masks the secrets it was given out of what a run says', () => {
    const code = generateSpec(input);
    expect(marksOf(code)).toEqual(['1', '2', '3', 'check 1']);
    const masked = judge({ status: 'failed', duration: 1, steps: [step('[2] Type ••• into the “Password” field', 'locator.fill(hunter2) timed out')] }, ['1', '2'], (t) => t?.split('hunter2').join('•••'));
    expect(masked.message).toBe('locator.fill(•••) timed out');
  });
});

describe('a run cut short', () => {
  it('leaves nothing behind for long: the next run sweeps its configuration and Playwright’s notes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-runs-'));
    const old = Date.now() / 1000 - 3600;
    for (const n of ['run-mabc12-a1b2c3.config.mjs', 'run-mabc12-a1b2c3.json']) {
      fs.writeFileSync(path.join(dir, n), 'x');
      fs.utimesSync(path.join(dir, n), old, old);
    }
    fs.mkdirSync(path.join(dir, 'run-mabc12-a1b2c3'));
    fs.writeFileSync(path.join(dir, 'run-mabc12-a1b2c3', 'error-context.md'), 'http://localhost:5174/?token=abc');
    fs.utimesSync(path.join(dir, 'run-mabc12-a1b2c3'), old, old);
    // One running now, and a file of someone else's, stay.
    fs.writeFileSync(path.join(dir, 'run-mnow99-ffffff.config.mjs'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    sweepRuns(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'run-mnow99-ffffff.config.mjs']);
  });
});
