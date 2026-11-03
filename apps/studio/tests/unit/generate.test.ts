import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { jsString } from '@saywright/vite/protocol';
import { generateSpec, safeLocator, writeSpec } from '../../server/tests/generate';
import { focusOn, parseFailure } from '../../server/tests/run';
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
  it('writes a readable Playwright test from the narration', () => {
    const code = generateSpec(input, new Date('2026-10-13T00:00:00Z'));
    expect(code).toContain("test('total should show $80.80', async ({ page }) => {");
    expect(code).toContain("await page.goto('/#/checkout');");
    expect(code).toContain("await page.getByTestId('coupon-input').fill('SAVE20');");
    expect(code).toContain('// Note: the discount looks too big');
    expect(code).toContain("await expect(page.getByTestId('summary-total')).toContainText('$80.80');");
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

  it('never overwrites an existing test file', () => {
    const p = tempShop();
    const a = writeSpec(p, input);
    const b = writeSpec(p, input);
    expect(a.path).toBe('tests/saywright/total-should-show-80-80.spec.ts');
    expect(b.path).toBe('tests/saywright/total-should-show-80-80-2.spec.ts');
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
