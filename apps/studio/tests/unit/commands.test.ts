import { describe, expect, it } from 'vitest';
import { looksLikeCheck, normalize, parseClientCommand, parseExpectation } from '../../src/core/commands';
import { checkNumbers, shouldBe, stateWord, uncheckable } from '../../shared/text';

const cmd = (t: string, failing = false) => parseClientCommand(t, { hasFailingTest: failing });

describe('studio commands said or typed', () => {
  it.each([
    ['keep it', 'keep'],
    ['Looks good!', 'keep'],
    ['ok ship it', 'keep'],
    ['undo', 'undo'],
    ['nope', 'undo'],
    ['go back', 'undo'],
    ['cancel', 'cancel'],
    ['never mind', 'cancel'],
    ['select the parent', 'parent'],
    ['go up', 'parent'],
    ['clear pins', 'clear'],
    ['start recording', 'mode'],
    ['generate a test', 'generate'],
    ['run the test again', 'run'],
    ['click this', 'click'],
    ['scroll down', 'scroll'],
    ['reload the app', 'reload'],
    ['what can I say', 'help'],
    ['open this in the editor', 'open'],
    ['pin that', 'add'],
    ['add this', 'add'],
    ['this too', 'add'],
    ['also that', 'add'],
    ['deselect', 'clear'],
    ['unselect this', 'clear'],
  ])('“%s” → %s', (text, kind) => {
    expect(cmd(text)?.kind).toBe(kind);
  });

  it('moves the selection: out, inside, next, previous', () => {
    for (const t of ['go up', 'select the container', 'go outside', 'zoom out']) expect(cmd(t)).toEqual({ kind: 'parent' });
    for (const t of ['go inside', 'select inside', 'the child', 'select the child', 'go down a level', 'zoom in']) expect(cmd(t)).toEqual({ kind: 'nav', to: 'child' });
    for (const t of ['next', 'the next one', 'select the next one', 'next item']) expect(cmd(t)).toEqual({ kind: 'nav', to: 'next' });
    for (const t of ['previous', 'the previous one', 'the one before']) expect(cmd(t)).toEqual({ kind: 'nav', to: 'prev' });
  });

  it('selects by name: “the card”, “the button inside”', () => {
    expect(cmd('the card')).toEqual({ kind: 'find', what: 'card', where: 'any' });
    expect(cmd('select the card')).toEqual({ kind: 'find', what: 'card', where: 'any' });
    expect(cmd('Select the product card please')).toEqual({ kind: 'find', what: 'product card', where: 'any' });
    expect(cmd('the button inside')).toEqual({ kind: 'find', what: 'button', where: 'in' });
    expect(cmd('select the image inside it')).toEqual({ kind: 'find', what: 'image', where: 'in' });
    expect(cmd('pick the form around it')).toEqual({ kind: 'find', what: 'form', where: 'out' });
    // Not names.
    expect(cmd('select this')).toEqual({ kind: 'select' });
    expect(cmd('select all')).toBeNull();
    expect(cmd('the total should be 80')).toBeNull();
    expect(cmd('the weather today')).toBeNull();
    expect(cmd('the product card')).toEqual({ kind: 'find', what: 'product card', where: 'any' });
  });

  it('leaves change requests to the server', () => {
    for (const t of ['make this bigger', 'make it red', 'rename this to Pay now', 'why is the total wrong?', 'keep this button but make it blue']) {
      expect(cmd(t)).toBeNull();
    }
  });

  it('switches modes by their names on screen, “write test mode” included', () => {
    for (const t of ['write test mode', 'switch to write test mode', 'go to record mode', 'record a bug']) expect(cmd(t)).toEqual({ kind: 'mode', mode: 'record' });
    expect(cmd('edit mode')).toEqual({ kind: 'mode', mode: 'edit' });
    expect(cmd('use mode')).toEqual({ kind: 'mode', mode: 'use' });
    // “Write a test” is still the test itself.
    expect(cmd('write a test')).toEqual({ kind: 'generate' });
  });

  it('“fix it” is a command only when a test is failing', () => {
    expect(cmd('fix it')).toBeNull();
    expect(cmd('fix it', true)?.kind).toBe('fix');
  });

  it('keeps the original casing for “type …”', () => {
    expect(cmd('type SAVE20 and press enter')).toEqual({ kind: 'type', text: 'SAVE20', submit: true });
    expect(cmd('Type “Hello World”.')).toEqual({ kind: 'type', text: 'Hello World', submit: false });
  });

  it('normalises filler words and punctuation', () => {
    expect(normalize('Okay, keep it please.')).toBe('keep it');
  });
});

describe('spoken expectations (Write test mode)', () => {
  it('reads what an element should show', () => {
    expect(parseExpectation('this should show $80.80')).toEqual({ subject: 'this', expected: '$80.80' });
    expect(parseExpectation('the total should be 80.80 dollars')).toEqual({ subject: 'the total', expected: '$80.80' });
    expect(parseExpectation('it should say “Free shipping”')).toEqual({ subject: 'it', expected: 'Free shipping' });
  });

  it('reads that a box should be checked, or not', () => {
    expect(parseExpectation('this should be checked')).toEqual({ subject: 'this', expected: 'checked' });
    expect(parseExpectation('it shouldn’t be ticked')).toEqual({ subject: 'it', expected: 'not checked' });
    expect(parseExpectation('this should not be selected.')).toEqual({ subject: 'this', expected: 'not checked' });
    expect(stateWord('checked')).toBe('checked');
    expect(stateWord('Selected')).toBe('checked');
    expect(stateWord('on')).toBe('checked');
    expect(stateWord('unchecked')).toBe('not checked');
    expect(stateWord('not checked')).toBe('not checked');
    expect(stateWord('off')).toBe('not checked');
    // Anything else is the text it should show.
    expect(stateWord('Checked out')).toBeNull();
    expect(stateWord('$80.80')).toBeNull();
  });

  it('numbers checks as the test does, in the order of the steps they follow', () => {
    // Said in this order: one after step 3, one after step 1, one at the end, one more after step 1.
    expect(checkNumbers([{ after: 3 }, { after: 1 }, {}, { after: 1 }], 5)).toEqual([3, 1, 4, 2]);
    expect(checkNumbers([{ after: 9 }, { after: 0 }], 2)).toEqual([2, 1]);
    expect(shouldBe({ expected: 'checked', field: 'checked' })).toBe('should be checked');
    expect(shouldBe({ expected: 'not checked', field: 'checked' })).toBe('should not be checked');
    expect(shouldBe({ expected: 'Express', field: 'select' })).toBe('should have “Express” chosen');
    expect(shouldBe({ expected: '$80.80' })).toBe('should show “$80.80”');
  });

  it('understands amounts said in words', () => {
    expect(parseExpectation('this should show eighty dollars eighty')?.expected).toBe('$80.80');
    expect(parseExpectation('the total should be eighty dollars and eighty cents')?.expected).toBe('$80.80');
    expect(parseExpectation('it should say twelve dollars')?.expected).toBe('$12');
    expect(parseExpectation('this should show one hundred and five dollars five')?.expected).toBe('$105.05');
    expect(parseExpectation('it should say lots of dollars')?.expected).toBe('lots of dollars');
  });

  it('drops the “but it shows …” tail', () => {
    expect(parseExpectation('this should show $80.80 but it shows $78.40')?.expected).toBe('$80.80');
  });

  it('expects what was said, not the comma or the value it is said against (“$64.64, not $51.71”)', () => {
    expect(parseExpectation('this should show $64.64, not $51.71')?.expected).toBe('$64.64');
    expect(parseExpectation('this should show $64.64; it shows $51.71')?.expected).toBe('$64.64');
    expect(parseExpectation('the total should be 64.64 not 51.71')?.expected).toBe('64.64');
    expect(parseExpectation('this should say Paid, but it says Pending.')?.expected).toBe('Paid');
    expect(parseExpectation('this should show Paid instead of Pending')?.expected).toBe('Paid');
    expect(parseExpectation('this should show Paid instead')?.expected).toBe('Paid');
  });

  it('takes a quoted value whole, and never cuts inside words that are part of the value', () => {
    expect(parseExpectation('this should show "Item not found"')?.expected).toBe('Item not found');
    expect(parseExpectation('this should show “Item not found”, not “Items: 3”')?.expected).toBe('Item not found');
    expect(parseExpectation("it should say “Don't panic”.")?.expected).toBe("Don't panic");
    expect(parseExpectation('this should show Item not found')?.expected).toBe('Item not found');
    // Cut at a comma: all of it is kept too, for an element that shows all of it.
    expect(parseExpectation('this should show Paid, not yet shipped')).toEqual({ subject: 'this', expected: 'Paid', whole: 'Paid, not yet shipped' });
  });

  it('reads a value that must not be there, and states Playwright checks itself', () => {
    expect(parseExpectation("this shouldn't show $51.71")).toEqual({ subject: 'this', expected: '$51.71', not: true });
    expect(parseExpectation('the total should not show $51.71, it should show $64.64')?.expected).toBe('$51.71');
    expect(parseExpectation('it should not say “Error: not found”')).toEqual({ subject: 'it', expected: 'Error: not found', not: true });
    expect(parseExpectation('this should be visible')).toEqual({ subject: 'this', expected: 'visible', state: 'visible' });
    expect(parseExpectation('this should be gone.')).toMatchObject({ state: 'hidden' });
    expect(parseExpectation("the button shouldn't be enabled")).toMatchObject({ subject: 'the button', state: 'disabled' });
    expect(parseExpectation('it should be greyed out')).toMatchObject({ state: 'disabled' });
    expect(parseExpectation('this should not be visible')).toMatchObject({ state: 'hidden' });
    // Checked and selected stay what they were: a box, an option, a tab.
    expect(parseExpectation('this should be selected')).toEqual({ subject: 'this', expected: 'selected' });
    expect(parseExpectation('this should not be selected')).toEqual({ subject: 'this', expected: 'not checked' });
  });

  it('knows a sentence shaped like a check, so Write test never sends it to the AI', () => {
    expect(looksLikeCheck('this should be more obvious')).toBe(true);
    expect(parseExpectation('this should be more obvious')).toBeNull();
    expect(parseExpectation('this should be bigger')).toBeNull();
    expect(parseExpectation('the status should be Active')?.expected).toBe('Active');
    expect(looksLikeCheck("it shouldn't wobble")).toBe(true);
    expect(looksLikeCheck('the total must add up')).toBe(true);
    expect(looksLikeCheck('make this bigger')).toBe(false);
    expect(looksLikeCheck('should I use a table here?')).toBe(false);
  });

  it('ignores ordinary requests', () => {
    expect(parseExpectation('make this bigger')).toBeNull();
  });
});

describe('a check about an embedded frame', () => {
  it('is refused with a sentence, and any other element is not', () => {
    expect(uncheckable({ tag: 'iframe' })).toBe('What is inside an embedded frame can’t be checked from the page around it: a test can only check what this page shows itself.');
    expect(uncheckable({ tag: 'IFRAME' })).not.toBeNull();
    for (const tag of ['div', 'span', 'img', 'input', 'select']) expect(uncheckable({ tag })).toBeNull();
  });
});
