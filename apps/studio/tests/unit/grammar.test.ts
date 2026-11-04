import { describe, expect, it } from 'vitest';
import { parseQuick } from '../../shared/grammar';

describe('parseQuick', () => {
  it.each([
    ['make this look like that, but smaller', { kind: 'copy', adjust: -1 }],
    ['make this look like that', { kind: 'copy', adjust: 0 }],
    ['move this above that', { kind: 'move', where: 'above' }],
    ['put this below that', { kind: 'move', where: 'below' }],
    ['remove this', { kind: 'remove' }],
    ['rename this to Redeem', { kind: 'text', value: 'Redeem' }],
    ['change the text to “Get 20% off”', { kind: 'text', value: 'Get 20% off' }],
    ['make it say Place order', { kind: 'text', value: 'Place order' }],
    ['make this bigger', { kind: 'step', dir: 1, amount: 1, focus: 'size' }],
    ['make it much smaller', { kind: 'step', dir: -1, amount: 2, focus: 'size' }],
    ['more padding', { kind: 'step', dir: 1, amount: 1, focus: 'spacing' }],
    ['make this primary', { kind: 'set', terms: ['primary'] }],
    ['make it red', { kind: 'set', terms: ['red'] }],
    ['make the total bold', { kind: 'set', terms: ['total', 'bold'] }],
  ])('%s', (text, expected) => {
    expect(parseQuick(text)).toEqual(expected);
  });

  it.each(['why is this $78.40?', 'explain how the discount is calculated for coupons'])('leaves questions to Claude: %s', (text) => {
    expect(parseQuick(text)).toBeNull();
  });

  it.each([
    ['Rename "Apply" to "Use code"', 'Use code'],
    ['Rename "Add to cart" to "Buy"', 'Buy'],
    ['rename this to “Buy now” please', 'Buy now'],
    ["change the label to 'Sam's picks'", "Sam's picks"],
  ])('takes the quoted new text and nothing after it: %s', (text, value) => {
    expect(parseQuick(text)).toEqual({ kind: 'text', value });
  });

  it.each(['Rename "Remove" to "Delete"', 'rename "Drop shipping" to "Free shipping"', 'rename "Move to cart" to "Save"'])('reads the words of a quoted name as a name, not as a command: %s', (text) => {
    expect(parseQuick(text)?.kind).toBe('text');
  });

  it.each([
    ['Rename "Apply" to "Use code" everywhere it appears', 'Use code'],
    ['rename it to Place order everywhere', 'Place order'],
    ['rename all of them to "Buy"', 'Buy'],
    ['change the text on every page to “Checkout”', 'Checkout'],
  ])('marks a rename meant for everywhere, so it is not a one-element quick edit: %s', (text, value) => {
    expect(parseQuick(text)).toEqual({ kind: 'text', value, everywhere: true });
  });

  it('leaves a rename that asks for more to Claude', () => {
    expect(parseQuick('change the label to "Buy" and make it red')).toBeNull();
  });

  it.each(['remove this', 'delete it', 'get rid of that button', 'please remove the VIP badge', 'hide this', 'delete', 'remove this from the page'])('removes the element when that is all that is asked: %s', (text) => {
    expect(parseQuick(text)).toEqual({ kind: 'remove' });
  });

  it.each(['make the Delete button ask for confirmation', 'make the Delete button red', 'remove the border', 'hide this on mobile', 'delete this row when it is empty', 'remove this and move that above', 'drop the shadow'])(
    'never removes the element for a request that only has a word like delete in it: %s',
    (text) => {
      expect(parseQuick(text)?.kind).not.toBe('remove');
    },
  );

  it.each([
    ['rename this to Remove', 'Remove'],
    ['rename this to Remove contact forever', 'Remove contact forever'],
    ['rename this to Hide details', 'Hide details'],
    ['change the text to Drop files here', 'Drop files here'],
    ['rename this to Terms and conditions', 'Terms and conditions'],
  ])('renames to words that are also commands: %s', (text, value) => {
    expect(parseQuick(text)).toEqual({ kind: 'text', value });
  });

  it.each(['make this bigger and red', 'make this red and rename it later', 'make it smaller then bold'])('leaves two things asked at once to the AI: %s', (text) => {
    expect(parseQuick(text)).toBeNull();
  });

  it.each([
    ['rename this to pay now', 'Pay now'],
    ['rename this to iOS users first', 'iOS users first'],
    ['rename this to "iOS users first"', 'iOS users first'],
    ['rename this to "e-mail settings"', 'e-mail settings'],
    ['rename this to Are you sure?', 'Are you sure?'],
    ['rename this to Save now!', 'Save now!'],
    ['rename this to Done.', 'Done'],
  ])('keeps the new text as written: quoted exactly, its own capitals and its question or exclamation mark: %s', (text, value) => {
    expect(parseQuick(text)).toEqual({ kind: 'text', value });
  });
});
