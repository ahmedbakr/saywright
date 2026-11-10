/**
 * What a test does for each kind of step Write test records, and what it refuses: the browser's dialogs answered as
 * the person did them, and the actions beyond a click, typing and Enter.
 */
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import type { RecordedStep } from '../../shared/api';
import { generateSpec } from '../../server/tests/generate';
import { validSteps } from '../../server/tests/validate';
import { keyName } from '../../../../packages/vite/src/bridge/recorder';

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

describe('actions beyond a click, typing and Enter', () => {
  it('writes each as Playwright does it: a double click, a right click, a key on the page, Shift+Enter, a hover, a drag, files chosen', () => {
    const code = spec([
      { kind: 'click', locator: "page.getByRole('button', { name: 'Like' })", count: 2, description: 'Double-click the “Like” button' },
      { kind: 'click', locator: "page.getByText('Report.pdf', { exact: true })", button: 'right', description: 'Right-click “Report.pdf”' },
      { kind: 'press', key: 'Control+k', description: 'Press Control+k' },
      { kind: 'press', locator: "page.getByRole('textbox', { name: 'Message' })", key: 'Shift+Enter', description: 'Press Shift+Enter in the “Message” field' },
      { kind: 'hover', locator: "page.getByRole('listitem').filter({ hasText: 'Products' })", description: 'Hover over “Products”' },
      { kind: 'drag', locator: "page.getByText('Charlie', { exact: true })", to: "page.getByText('Alpha', { exact: true })", description: 'Drag “Charlie” onto “Alpha”' },
      { kind: 'upload', locator: "page.getByLabel('Invoice')", files: [{ name: "march's invoice.pdf", mimeType: 'application/pdf' }], description: 'Choose “march’s invoice.pdf” in the “Invoice” field' },
      { kind: 'missed', description: 'Not recorded: something you did inside an embedded frame' },
    ]);
    expect(code).toContain("await page.getByRole('button', { name: 'Like' }).dblclick();");
    expect(code).toContain("await page.getByText('Report.pdf', { exact: true }).click({ button: 'right' });");
    expect(code).toContain("await page.keyboard.press('Control+k');");
    expect(code).toContain("await page.getByRole('textbox', { name: 'Message' }).press('Shift+Enter');");
    expect(code).toContain("await page.getByRole('listitem').filter({ hasText: 'Products' }).hover();");
    expect(code).toContain("await page.getByText('Charlie', { exact: true }).dragTo(page.getByText('Alpha', { exact: true }));");
    expect(code).toContain("    // It uploads an empty file named as yours: put real content in its buffer if the app reads the file.\n    await page.getByLabel('Invoice').setInputFiles({ name: 'march\\'s invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('') });");
    expect(code).toContain("  // Not recorded: something you did inside an embedded frame: the test can't do this, so it may not get as far as you did.");
  });

  it('refuses what a test can’t do with them', () => {
    expect(validSteps([{ kind: 'press', key: 'n', description: 'Press n' }])[0]).toEqual({ kind: 'press', key: 'n', description: 'Press n' });
    expect(validSteps([{ kind: 'click', locator: "page.getByText('a')", count: 2, button: 'right', description: 'x' }])[0]).toMatchObject({ count: 2, button: 'right' });
    expect(() => validSteps([{ kind: 'click', locator: "page.getByText('a')", count: 3, description: 'x' }])).toThrow(/count must be 1 or 2/);
    expect(() => validSteps([{ kind: 'click', locator: "page.getByText('a')", button: 'middle', description: 'x' }])).toThrow(/button can only be “right”/);
    expect(() => validSteps([{ kind: 'drag', locator: "page.getByText('a')", description: 'x' }])).toThrow(/names nothing to drop onto/);
    expect(() => validSteps([{ kind: 'drag', locator: "page.getByText('a')", to: 'process.exit(1)', description: 'x' }])).toThrow(/isn’t a locator/);
    expect(() => validSteps([{ kind: 'upload', locator: "page.getByLabel('a')", description: 'x' }])).toThrow(/must list the files/);
    expect(() => validSteps([{ kind: 'upload', locator: "page.getByLabel('a')", files: [{ mimeType: 'a/b' }], description: 'x' }])).toThrow(/file 1 has no name/);
    expect(validSteps([{ kind: 'missed', description: 'Not recorded: a shape drawn with the pointer on a canvas' }])).toHaveLength(1);
  });
});

describe('keys as Playwright presses them', () => {
  const k = (key: string, code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => keyName({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
  it('names the modifiers, and never writes Shift+Enter as Enter', () => {
    expect(k('Enter', 'Enter', { shiftKey: true })).toBe('Shift+Enter');
    expect(k('k', 'KeyK', { ctrlKey: true })).toBe('Control+k');
    expect(k('P', 'KeyP', { metaKey: true, shiftKey: true })).toBe('Meta+Shift+p');
    // Alt+n on a Mac makes “˜”: the key is n.
    expect(k('˜', 'KeyN', { altKey: true })).toBe('Alt+n');
    expect(k('?', 'Slash', { shiftKey: true })).toBe('?');
    expect(k('n', 'KeyN')).toBe('n');
    expect(k('ArrowDown', 'ArrowDown', { shiftKey: true })).toBe('Shift+ArrowDown');
  });
});
