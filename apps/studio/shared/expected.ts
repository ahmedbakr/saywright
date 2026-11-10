/**
 * What a tester said something should show, from their words in English or Arabic: "this should show eighty
 * dollars eighty" → $80.80. Amounts may be written ($80.80, 80.80 dollars, ٨٠٫٨٠ دولار) or spoken (eighty dollars
 * eighty, ثمانين دولار وثمانين سنت). A sentence often says more than that ("The total looks wrong. … This should
 * show $80.80."): the part that says what it should be is found, with where it is in the sentence, so what was
 * pointed at while it was said can be told apart from what was pointed at before.
 */
import { arabicAmount } from './arabic-commands.ts';

interface SaidValue {
  /** As the page would show it: "$80.80", or the quoted words ("Free shipping"). */
  expected: string;
  /** How far into the sentence the part saying it starts, from 0 to 1: about when it was said. */
  at: number;
}

interface Amount {
  value: number;
  /** The symbol or word written with it, as found ("$", "EGP", "دولار"). */
  currency: string;
  index: number;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "seventy eight" → 78, "one hundred and five" → 105, "12" → 12. Null when it isn't a whole number. */
function spokenNumber(text: string): number | null {
  let total = 0;
  let current = 0;
  let any = false;
  for (const w of text.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean)) {
    if (w === 'and' && any) continue;
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
    } else if (/^\d+$/.test(w)) current += Number(w);
    else return null;
    any = true;
  }
  return any ? total + current : null;
}

/** Amounts said in words: "eighty dollars eighty", "eighty dollars and eighty cents" → "$80.80". */
export function spokenMoney(text: string): string | null {
  const m = /^(.+?)\s+(?:dollars?|bucks)(?:\s+(?:and\s+)?(.+?)(?:\s+cents?)?)?$/i.exec(text.trim());
  if (!m) return null;
  const whole = spokenNumber(m[1]);
  if (whole === null) return null;
  if (!m[2]) return `$${whole}`;
  const cents = spokenNumber(m[2]);
  return cents === null || cents > 99 ? null : `$${whole}.${String(cents).padStart(2, '0')}`;
}

/** Arabic-Indic digits and separators as ASCII ones: ٨٠٫٨٠ → 80.80. */
function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/(\d)\s?٫\s?(\d)/g, '$1.$2')
    .replace(/(\d)٬(\d)/g, '$1$2');
}

const SYMBOL = '(?:US\\$|[$€£¥₹]|E£)';
const WORD = '(?:USD|EUR|GBP|EGP|SAR|AED|dollars?|bucks|euros?|pounds?|دولار(?:ات)?|جنيه(?:ات)?|ريال(?:ات)?|درهم|يورو)';
const NUMBER = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?';
// A symbol after a number is that number's only when no other number follows it ("Qty 1 $32.00" is one amount).
const WRITTEN = new RegExp(`(${SYMBOL})\\s?(${NUMBER})|(${NUMBER})\\s?(?:(${SYMBOL})(?!\\s?\\d)|(${WORD})(?!\\p{L}))`, 'giu');

/** "1,250.00" and "80,80" (a decimal comma) as numbers. */
function numberOf(s: string): number {
  return Number(/^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, ''));
}

/** Amounts of money written in a text (a page's, a report's), in order: "$80.80", "80.80 EGP", "٨٠٫٨٠ دولار". */
export function amountsIn(text: string): Amount[] {
  const t = asciiDigits(text);
  const out: Amount[] = [];
  for (const m of t.matchAll(WRITTEN)) out.push({ value: numberOf(m[2] ?? m[3]), currency: m[1] ?? m[4] ?? m[5], index: m.index ?? 0 });
  return out;
}

/** An amount as a page shows it: "$80.80", "$12", "€5.50", "80.80 EGP". */
export function moneyText(value: number, currency: string): string {
  const n = Number.isInteger(value) ? String(value) : value.toFixed(2);
  const c = currency.toLowerCase();
  if (/^(?:us\$|\$|usd|dollars?|bucks|دولار(?:ات)?)$/.test(c)) return `$${n}`;
  if (/^(?:€|eur|euros?|يورو)$/.test(c)) return `€${n}`;
  if (/^(?:£|gbp|pounds?)$/.test(c)) return `£${n}`;
  if (/^(?:e£|egp|جنيه(?:ات)?)$/.test(c)) return `${n} EGP`;
  return /^\p{L}/u.test(currency) ? `${n} ${currency}` : `${currency}${n}`;
}

/** Words that say what something should be, in English and Arabic (Modern Standard and Egyptian). */
const SHOULD_EN = /\b(?:should|must|needs? to|ought to|(?:is|are) supposed to|has to|have to)\s+(?:be|say|show|read|display|equal|contain|have|include|cost|come to)\b|\bexpected\b/gi;
const SHOULD_AR = /(?:من المفروض|المفروض|يفترض|لازم|يجب ان|يجب أن|ينبغي ان|ينبغي أن|المتوقع)/g;

/** The value said after one of those words: an amount, written or spoken, or quoted words. */
function valueIn(clause: string): string | null {
  // Up to where the sentence moves on ("…, not $78.40", "… but it shows …").
  const said = clause.replace(/(?:[.!?](?!\d)|,?\s+(?:but|instead|and not|not)\b|\s+(?:مش|وليس|بدل|بس)\s).*$/is, '').trim();
  const written = amountsIn(said)[0];
  if (written) return moneyText(written.value, written.currency);
  // A price said without its currency ("should be 80.80").
  const price = /(?:^|\s)(\d+\.\d{2})$/.exec(asciiDigits(said));
  if (price) return price[1];
  const spoken = spokenMoney(said.replace(/^(?:be|say|show|read|display|equal|contain|have|include|cost|come to)\s+/i, '').replace(/[.!?,]+$/, ''));
  if (spoken) return spoken;
  if (/[؀-ۿ]/.test(said)) {
    const ar = arabicAmount(said);
    if (ar && ar.currency) return moneyText(ar.value, ar.currency);
  }
  const quoted = /["“«]([^"”»]{1,80})["”»]/.exec(clause);
  return quoted ? quoted[1].trim() : null;
}

/**
 * What a sentence says something should show, without the part where it moves on to what it shows instead: “$64.64,
 * not $51.71” → “$64.64”; “80.80 not 78.40” → “80.80”; “Paid but it shows Pending” → “Paid”. Words that are only
 * part of the value stay: “Item not found” is all of it. No punctuation is left at its end.
 */
export function cutSaid(said: string): string {
  return said
    .replace(/\s*[,;]\s*(?:(?:and|but|or)\s+)?(?:not|but|instead|rather than|whereas|while|it shows|it says|it's|it is)\b.*$/is, '')
    .replace(/\s*;.*$/s, '')
    .replace(/\s+(?:but|instead of|rather than|whereas)\b.*$/is, '')
    .replace(/\s+instead[.!?]*$/i, '')
    // “not” without a comma ends it only before another value: “80.80 not 78.40”, “Paid and not “Due””.
    .replace(/\s+(?:and\s+)?not\s+(?=[$€£¥₹"“‘'«]|\d).*$/is, '')
    .replace(/\s+(?:مش|وليس|بدل|بس)\s.*$/s, '')
    .replace(/[\s.,;:!?]+$/, '')
    .trim();
}

/**
 * The value a sentence says something should show, from the last part of it that says one, or null when it says
 * none (an opinion like “this should be bigger” is no value to check).
 */
export function saidValue(sentence: string): SaidValue | null {
  const text = sentence.trim();
  if (!text) return null;
  const cues = [...text.matchAll(SHOULD_EN), ...text.matchAll(SHOULD_AR)].sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
  for (const cue of cues) {
    const from = (cue.index ?? 0) + cue[0].length;
    const expected = valueIn(text.slice(from));
    if (expected) return { expected, at: sentenceStart(text, cue.index ?? 0) / text.length };
  }
  return null;
}

/** Where the sentence holding position `i` starts ("The total looks wrong. This should show …" → at "This"). */
function sentenceStart(text: string, i: number): number {
  let start = 0;
  for (const m of text.slice(0, i).matchAll(/[.!?؟]\s+/g)) start = (m.index ?? 0) + m[0].length;
  return start;
}

/** When the part of a sentence saying what something should be was said, by where it is in the words. */
export function saidAt(seg: { start: number; end: number }, value: SaidValue): number {
  return Math.round(seg.start + (seg.end - seg.start) * value.at);
}

/**
 * Whether what an element shows is the value expected: the same amount, however it is written ($80.8 is $80.80,
 * and $8 is not $80.80), or the same words as a whole (“active” is not in “Inactive”, “5 in stock” not in “15 in
 * stock”), whatever their case.
 */
export function showsValue(actual: string, expected: string): boolean {
  const want = amountOf(expected);
  if (want === null) return new RegExp(wholeValue(expected).source, 'iu').test(asciiDigits(actual));
  const found = amountsIn(actual);
  const numbers = found.length ? found.map((a) => a.value) : [...asciiDigits(actual).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  return numbers.some((n) => Math.abs(n - want) < 0.005);
}

/** The amount a value says, written with its currency or like a price ("80.80"); null for anything else. */
function amountOf(expected: string): number | null {
  const t = asciiDigits(expected).trim();
  const found = amountsIn(t);
  // Only a value that is an amount and nothing else ("$80.80", "80.80 EGP"), not words with one in them.
  if (found.length === 1 && t.replace(WRITTEN_ONE, '').trim() === '') return found[0].value;
  return PRICE.test(t) ? Number(t) : null;
}

/** A number written like a price, without its currency: "80.80". */
const PRICE = /^\s*\d+\.\d{2}\s*$/;
const WRITTEN_ONE = new RegExp(`(${SYMBOL})\\s?(${NUMBER})|(${NUMBER})\\s?(?:(${SYMBOL})|(${WORD})(?!\\p{L}))`, 'iu');

/**
 * How a check finds a value in what an element shows: as a whole, never inside a longer word or number. An amount is
 * found by its value (with its symbol when it was said with one): $80.80 is “$80.8”, “$ 80.80” and “$80,80”, never “$180.80”.
 * Words are found with any spaces between them, and not inside longer ones. `source` is a regular expression's,
 * safe in a literal (/…/): every special character is escaped and every line break is \s. `only`: the value and
 * nothing else (an option of a list).
 */
export function wholeValue(expected: string): { source: string; only: string; amount: boolean; why: string } {
  const value = asciiDigits(expected).trim();
  const want = amountOf(value);
  if (want !== null) {
    const symbol = new RegExp(`^${SYMBOL}`, 'i').exec(value)?.[0];
    const [whole, cents = ''] = want.toFixed(2).split('.');
    const int = whole.replace(/\B(?=(\d{3})+$)/g, ',?');
    const frac = cents.replace(/0+$/, '');
    const number = `${int}${frac ? `[.,]${frac}0*` : '(?:[.,]0+)?'}`;
    const core = symbol ? `${escapeRe(symbol)}\\s?${number}` : number;
    const source = symbol ? `${core}${END_DIGIT}` : `${START_DIGIT}${core}${END_DIGIT}`;
    return { source, only: `^\\s*${core}\\s*$`, amount: true, why: `${expected.trim()} as an amount, not part of a longer number` };
  }
  const body = value.split(/\s+/).map(escapeRe).join('\\s+');
  const first = value[0] ?? '';
  const last = value[value.length - 1] ?? '';
  const start = /\d/.test(first) ? START_DIGIT : /[A-Za-z_]/.test(first) ? '\\b' : /\p{L}/u.test(first) ? '(?<!\\p{L})' : '';
  const end = /\d/.test(last) ? END_DIGIT : /[A-Za-z_]/.test(last) ? '\\b' : /\p{L}/u.test(last) ? '(?!\\p{L})' : '';
  return { source: `${start}${body}${end}`, only: `^\\s*${body}\\s*$`, amount: false, why: `“${expected.trim()}” as a whole, not inside a longer word or number` };
}

/**
 * Words said as the element shows them: speech writes “free shipping” for “Free shipping”. When the element shows
 * the words in another case, they are taken as shown (the check then says what the page says); when it doesn't show
 * them at all, they are compared without case (`anyCase`). Amounts and numbers are left as they are.
 */
export function asShown(actual: string, expected: string): { expected: string; anyCase?: true } {
  const whole = wholeValue(expected);
  if (whole.amount || !/\p{L}/u.test(expected)) return { expected };
  if (new RegExp(whole.source, 'u').test(actual)) return { expected };
  const shown = new RegExp(whole.source, 'iu').exec(actual);
  return shown ? { expected: shown[0].replace(/\s+/g, ' ') } : { expected, anyCase: true };
}

/** Not right after a digit, a sign, or a separator that goes on a number; not right before more of it. */
const START_DIGIT = '(?<![\\d.,−-])';
const END_DIGIT = '(?![.,]?\\d)';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
