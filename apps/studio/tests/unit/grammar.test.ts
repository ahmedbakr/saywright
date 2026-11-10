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

  // Each of these was once taken for a quick edit because one of its words ("bigger", "says", "primary", "below")
  // was somewhere in the sentence, and code changed that nobody asked to change.
  it.each([
    'add a tooltip that says secure payment',
    'the label reads wrong, fix the typo',
    'show a toast that says Saved when clicked',
    'add a confirm dialog that says Are you sure?',
    'why is this so much bigger than the other one?',
    'is this bigger than 44 pixels?',
    'can you explain why this is tiny?',
    'what does this do',
    'explain this',
    'test this',
    "don't make it bigger",
    'it should not be smaller than the title',
    'make this smaller on mobile',
    'make the font bigger on hover',
    'make it bigger when the cart is empty',
    'make the price bigger than the title',
    'make the hit area larger without changing how it looks',
    'make the image load faster and smaller in bytes',
    'increase the discount to 30%',
    'decrease the shipping cost to $10',
    'increase the timeout to 5 seconds',
    'increase the quantity when I click plus',
    'increase the total',
    'grow the list when new items arrive',
    'shrink the image file size',
    'give it more room for error messages',
    'remove the trailing space in the label',
    'delete the item when I click this',
    'hide this until the form is valid',
    'move the focus here after submit',
    'put a divider below this',
    'place an icon before the text',
    'make it primary only for logged in users',
    'make it secondary when disabled',
    'make it red if the coupon is invalid',
    'use the danger style when the total is negative',
    'give it a red border',
    'rename the CSS class to btn-primary',
    'rename the function to handlePay',
    'call the API when this is clicked',
    'call onPay to submit the order',
    'change the label color to red',
    'set the title to bold',
  ])('leaves to the AI a request that only has a quick edit’s word in it: %s', (text) => {
    expect(parseQuick(text)).toBeNull();
  });

  // Words that could name a value of the component's own props are only ever a "set": whether there is such a value,
  // and whether the rest of the request is about it, is decided where the component is known (quick.test.ts).
  it.each(['make this compact mode optional', 'set the default to express', 'change the currency to euros', 'make it link to /terms', 'turn this into a dropdown', 'make it read-only', 'make this required', 'make it disabled', 'make it sticky', 'make it full width'])(
    'never takes a request about something else for a size, a text, a move or a removal: %s',
    (text) => {
      expect(['set', undefined]).toContain(parseQuick(text)?.kind);
    },
  );

  it.each([
    ['bigger', { kind: 'step', dir: 1, amount: 1, focus: 'size' }],
    ['smaller', { kind: 'step', dir: -1, amount: 1, focus: 'size' }],
    ['much smaller', { kind: 'step', dir: -1, amount: 2, focus: 'size' }],
    ['make it a lot bigger', { kind: 'step', dir: 1, amount: 2, focus: 'size' }],
    ['a bit smaller please', { kind: 'step', dir: -1, amount: 1, focus: 'size' }],
    ['can you make this bigger?', { kind: 'step', dir: 1, amount: 1, focus: 'size' }],
    ['make the total larger', { kind: 'step', dir: 1, amount: 1, focus: 'size' }],
    ['grow this', { kind: 'step', dir: 1, amount: 1, focus: 'size' }],
    ['shrink it', { kind: 'step', dir: -1, amount: 1, focus: 'size' }],
    ['reduce the size of this', { kind: 'step', dir: -1, amount: 1, focus: 'size' }],
    ['more spacing', { kind: 'step', dir: 1, amount: 1, focus: 'spacing' }],
    ['less spacing', { kind: 'step', dir: -1, amount: 1, focus: 'spacing' }],
    ['tighter', { kind: 'step', dir: -1, amount: 1, focus: 'spacing' }],
    ['make it roomier', { kind: 'step', dir: 1, amount: 1, focus: 'spacing' }],
    ['increase the padding', { kind: 'step', dir: 1, amount: 1, focus: 'spacing' }],
    ['give it more room', { kind: 'step', dir: 1, amount: 1, focus: 'spacing' }],
    ['rename to Place order', { kind: 'text', value: 'Place order' }],
    ['call it Submit', { kind: 'text', value: 'Submit' }],
    ['it should say Pay now', { kind: 'text', value: 'Pay now' }],
    ['make this say "Pay"', { kind: 'text', value: 'Pay' }],
    ['rename the Pay button to Place order', { kind: 'text', value: 'Place order' }],
    ['delete that button', { kind: 'remove' }],
    ['remove this please', { kind: 'remove' }],
    ['move it after that', { kind: 'move', where: 'below' }],
    ['move the badge before the title', { kind: 'move', where: 'above' }],
    ['make it secondary', { kind: 'set', terms: ['secondary'] }],
    ['ghost', { kind: 'set', terms: ['ghost'] }],
    ['link', { kind: 'set', terms: ['link'] }],
    ['make it outline', { kind: 'set', terms: ['outline'] }],
    ['use the danger variant', { kind: 'set', terms: ['danger'] }],
    ['make it a ghost button', { kind: 'set', terms: ['ghost', 'button'] }],
    ['set it to large', { kind: 'set', terms: ['large'] }],
    ['change it to secondary', { kind: 'set', terms: ['secondary'] }],
    ['switch to ghost', { kind: 'set', terms: ['ghost'] }],
    ['same style as that', { kind: 'copy', adjust: 0 }],
    ['make this match that', { kind: 'copy', adjust: 0 }],
  ])('takes a quick edit said in its usual ways: %s', (text, expected) => {
    expect(parseQuick(text)).toEqual(expected);
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
