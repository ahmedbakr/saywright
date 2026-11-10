/**
 * What a test does for each kind of step Write test records, and what it refuses: the browser's dialogs answered as
 * the person did them, and the actions beyond a click, typing and Enter.
 */
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import type { RecordedStep } from '../../shared/api';
import { generateSpec } from '../../server/tests/generate';
import { validSteps } from '../../server/tests/validate';

const expectations = [{ locator: "page.getByTestId('status')", description: 'the status', expected: 'Account: deleted', actual: 'Account: deleted' }];
const spec = (steps: RecordedStep[]) => {
  const code = generateSpec({ startUrl: 'http://localhost:5174/', steps, expectations }, new Date('2026-11-10T00:00:00Z'));
  // Always a test that parses.
  parse(code, { sourceType: 'module', plugins: ['typescript'] });
  return code;
};
const click = (name: string): RecordedStep => ({ kind: 'click', locator: `page.getByRole('button', { name: '${name}' })`, description: `Click the “${name}” button` });

describe('dialogs', () => {
  it('a confirm answered OK, a prompt answered with words, a confirm cancelled: each answered so before its step', () => {
    const code = spec([
      { ...click('Delete account'), dialogs: [{ type: 'confirm', accept: true, message: 'Really delete?' }] },
      { ...click('Rename'), dialogs: [{ type: 'prompt', accept: true, text: 'Zephyr', message: 'New name?' }] },
      { ...click('Leave'), dialogs: [{ type: 'confirm', accept: false, message: 'Leave the team?' }] },
    ]);
    expect(code).toContain(
      "  await test.step('[2] Click the “Delete account” button', async () => {\n    // It opens “Really delete?”: OK, answered as you did.\n    page.once('dialog', (dialog) => dialog.accept());\n    await page.getByRole('button', { name: 'Delete account' }).click();",
    );
    expect(code).toContain("page.once('dialog', (dialog) => dialog.accept('Zephyr'));\n    await page.getByRole('button', { name: 'Rename' }).click();");
    expect(code).toContain("// It opens “Leave the team?”: Cancel, answered as you did.\n    page.once('dialog', (dialog) => dialog.dismiss());");
  });

  it('two dialogs from one step are answered in turn, each by its own answer', () => {
    const code = spec([{ ...click('Delete'), dialogs: [{ type: 'confirm', accept: true }, { type: 'alert', accept: true, message: 'Deleted' }] }]);
    expect(code).toContain("// It opens a confirm: OK, then “Deleted”: OK, answered as you did.");
    expect(code).toContain("page.once('dialog', (dialog) => { page.once('dialog', (dialog) => dialog.accept()); return dialog.accept(); });");
  });

  it('what the page said and what was typed stay inside strings and comments', () => {
    const code = spec([{ ...click('Go'), dialogs: [{ type: 'prompt', accept: true, text: "it's */ done\n');process.exit(1)//", message: '*/ process.exit(2) /*' }] }]);
    expect(code).not.toMatch(/^\s*process\.exit/m);
  });

  it('a step’s dialogs are checked where they come in', () => {
    expect(validSteps([{ ...click('Go'), dialogs: [{ type: 'confirm', accept: true, message: 'Sure?' }] }])[0].dialogs).toEqual([{ type: 'confirm', accept: true, message: 'Sure?' }]);
    expect(() => validSteps([{ ...click('Go'), dialogs: [{ type: 'print', accept: true }] }])).toThrow(/Step 1, dialog 1 is “print”/);
    expect(() => validSteps([{ ...click('Go'), dialogs: [{ type: 'confirm', accept: 'yes' }] }])).toThrow(/accept must be true or false/);
    expect(() => validSteps([{ ...click('Go'), dialogs: 'ok' }])).toThrow(/dialogs must be a list/);
  });
});
