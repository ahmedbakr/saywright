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
});
