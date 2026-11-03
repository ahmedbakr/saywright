import { describe, expect, it } from 'vitest';
import { normalize, parseClientCommand, parseExpectation } from '../../src/core/commands';

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

  it('ignores ordinary requests', () => {
    expect(parseExpectation('make this bigger')).toBeNull();
  });
});
