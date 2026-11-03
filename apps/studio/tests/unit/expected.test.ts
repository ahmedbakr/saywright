/**
 * What a tester said something should show, taken from their own words: amounts written or spoken, in English or
 * Arabic, with Western or Arabic-Indic digits, out of a sentence that says more than that.
 */
import { describe, expect, it } from 'vitest';
import { amountsIn, saidAt, saidValue, showsValue } from '../../shared/expected';

describe('the value a sentence says something should show', () => {
  it.each([
    ['this should show $80.80', '$80.80'],
    // As recognisers write it.
    ['This should show$80.80.', '$80.80'],
    ['This should show$80.8.', '$80.80'],
    ['the total should be 80.80 dollars', '$80.80'],
    ['this should show eighty dollars eighty', '$80.80'],
    ['it should be eighty dollars and eighty cents, not seventy eight forty', '$80.80'],
    ['it should say twelve dollars', '$12'],
    ['the total should be 80.80', '80.80'],
    ['it should say “Free shipping”', 'Free shipping'],
    ['this should show $80.80 but it shows $78.40', '$80.80'],
  ])('%s → %s', (sentence, expected) => {
    expect(saidValue(sentence)?.expected).toBe(expected);
  });

  it('is taken from the part that says it, in a sentence that says more', () => {
    const s = 'The total looks wrong. Twenty percent should only come off the items, not the shipping. This should show eighty dollars eighty.';
    const v = saidValue(s)!;
    expect(v.expected).toBe('$80.80');
    expect(s.slice(Math.round(v.at * s.length))).toMatch(/^This should show/);
    // Said in the last part of the six seconds the sentence took.
    expect(saidAt({ start: 1000, end: 7000 }, v)).toBeGreaterThan(4500);
  });

  it.each([
    ['المفروض يكون ثمانين دولار وثمانين سنت', '$80.80'],
    // As a recogniser heard it, cut short at the end: the last part saying it holds the amount.
    ['الاجمال يغاط الخصم المفروض يكون علي المنتجات بس مش علي الشن المفروض يكون ثمانين دولار وثمانين سن', '$80.80'],
    ['المفروض يظهر ٨٠٫٨٠ دولار', '$80.80'],
    ['يجب أن يكون الإجمالي 80.80 دولار', '$80.80'],
  ])('in Arabic: %s → %s', (sentence, expected) => {
    expect(saidValue(sentence)?.expected).toBe(expected);
  });

  it.each(['this should be much bigger', 'the button should have more space', 'Twenty percent should only come off the items', 'the total looks wrong', 'المفروض يكون أوضح'])(
    'is none when no value is said: %s',
    (s) => {
      expect(saidValue(s)).toBeNull();
    },
  );
});

describe('amounts written on a page', () => {
  it('are found with their currency, in order, whatever digits they use', () => {
    expect(amountsIn('Subtotal $86.00 Shipping $12.00 Total $78.40').map((a) => a.value)).toEqual([86, 12, 78.4]);
    expect(amountsIn('Discount (SAVE20) −$19.60')).toMatchObject([{ value: 19.6, currency: '$' }]);
    expect(amountsIn('الإجمالي ٧٨٫٤٠ دولار')).toMatchObject([{ value: 78.4, currency: 'دولار' }]);
    expect(amountsIn('1,250.00 EGP · 80,80 €')).toMatchObject([
      { value: 1250, currency: 'EGP' },
      { value: 80.8, currency: '€' },
    ]);
    expect(amountsIn('SAVE20 · 2 × 250 g')).toEqual([]);
  });

  it('match what was said by amount, not by characters', () => {
    expect(showsValue('Total $80.80', '$80.80')).toBe(true);
    expect(showsValue('Total $80.80', '80.80')).toBe(true);
    expect(showsValue('الإجمالي ٨٠٫٨٠ دولار', '$80.80')).toBe(true);
    expect(showsValue('Total $78.40', '$80.80')).toBe(false);
    // "$8" is in "$80.80" as text, not as an amount.
    expect(showsValue('Total $80.80', '$8')).toBe(false);
    expect(showsValue('Single-origin beans · Qty 1 $32.00', '$1')).toBe(false);
    expect(showsValue('Free shipping over $75', 'Free shipping')).toBe(true);
  });
});
