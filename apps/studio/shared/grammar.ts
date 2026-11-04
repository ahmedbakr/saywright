/**
 * The small vocabulary that is handled instantly and offline. Anything that
 * doesn't parse here goes to the AI.
 */
export type QuickIntent =
  | { kind: 'copy'; adjust: -1 | 0 | 1 }
  | { kind: 'move'; where: 'above' | 'below' }
  | { kind: 'remove' }
  /** `everywhere`: the same words wherever they appear, not only in what was pointed at (a job for the AI). */
  | { kind: 'text'; value: string; everywhere?: true }
  | { kind: 'step'; dir: 1 | -1; amount: 1 | 2; focus: 'size' | 'spacing' }
  | { kind: 'set'; terms: string[] };

const STOP = new Set(
  'a an the this that these those it its to into as be is are was make makes made turn change set use using with please can you could would just look looks like more less bit little lot much way really so and also now then on in of for here there me my our your some kind sort'.split(' '),
);

/** A request about more than the one element: "everywhere", "all of them", "on every page". */
const EVERYWHERE = /\b(?:everywhere|wherever|throughout|all of (?:them|these|those)|(?:all|every|each) (?:the )?(?:one|ones|instances?|occurrences?|places?|pages?|screens?|buttons?|links?|labels?|copies)|across the (?:app|site|page|pages|project))\b/i;
/** The same, closing an unquoted new text: "rename it to Place order everywhere it appears". */
const EVERYWHERE_AT_END = new RegExp(`\\s+(?:${EVERYWHERE.source})(?:\\s+(?:it|they)\\s+(?:appears?|shows?|is|are)(?:\\s+used)?)?[.!]*$`, 'i');
/** What may follow a quoted new text without asking for anything more. */
const POLITE = /^(?:please|thanks|thank you|instead|now|for me)?[.!]*$/i;
const MARK = /\uE000(\d+)\uE000/g;

/** An unquoted new text without the quotes and the full stop around it ("Are you sure?" keeps its question mark). */
function stripQuotes(s: string): string {
  return s.replace(/^[\s"“'‘]+|[\s"”'’.]+$/g, '');
}

/** Words that make a removal about something of the element, or about when, rather than the element itself. */
const NOT_THE_ELEMENT = new Set(
  'on in at for when if unless until while after before and but or so then with without except only instead to into than border borders shadow shadows padding margin margins spacing space gap underline background bg color colour outline radius rounded rounding corner corners bold italic animation transition scrollbar placeholder tooltip focus hover opacity blur gradient style styles styling class classes wrap wrapping overflow limit validation confirmation delay duplicate duplicates uppercase lowercase'.split(' '),
);

/**
 * What a request that starts with remove, delete, drop or hide asks to go: the element itself ("remove this", "get
 * rid of that button", "delete the VIP badge"), or something of it ("remove the border", "hide this on mobile").
 * Null for any other request: a word like delete in "make the Delete button ask first" is no reason to delete anything.
 */
function removal(asked: string): 'element' | 'other' | null {
  const s = asked.trim().replace(/^(?:(?:please|can you|could you|would you|just|now)\s+)+/, '');
  const verb = /^(?:remove|delete|get rid of|drop|hide)\b(.*)$/.exec(s);
  if (!verb) return null;
  const rest = verb[1]
    .replace(/\b(?:please|now|entirely|completely|altogether|for me)\b/g, ' ')
    .replace(/\bfrom (?:the |this )?(?:page|screen|view|app)\b/g, ' ')
    .trim();
  const words = rest ? rest.split(/\s+/) : [];
  return words.length <= 4 && !words.some((w) => NOT_THE_ELEMENT.has(w)) ? 'element' : 'other';
}

/**
 * The quoted parts of a request ("…", “…”, «…», '…'), each replaced by a marker so the words around them are read
 * on their own: in `Rename "Add to cart" to "Buy"` the first "to" is part of a name, and in `Rename "Remove" to
 * "Delete"` nothing is to be removed.
 */
function quoted(s: string): { masked: string; values: string[] } {
  const values: string[] = [];
  const masked = s.replace(/"([^"]*)"|“([^”]*)”|«([^»]*)»|(?<![\p{L}\p{N}])'([^']*)'(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])‘([^’]*)’(?![\p{L}\p{N}])/gu, (...m: unknown[]) => {
    values.push(String(m.slice(1, 6).find((g) => g !== undefined) ?? ''));
    return `\uE000${values.length - 1}\uE000`;
  });
  return { masked, values };
}

/**
 * The new text a rename asks for, whether it is for every place it appears, and whether it was quoted (then it is
 * taken exactly as written); null when more is asked of it than a rename.
 */
function newText(tail: string, values: string[]): { value: string; everywhere: boolean; quoted: boolean } | null {
  const lead = /^\s*\uE000(\d+)\uE000(.*)$/s.exec(tail);
  if (lead) {
    const value = values[Number(lead[1])].trim();
    const rest = lead[2].replace(MARK, (_m, i: string) => values[Number(i)]).trim();
    if (EVERYWHERE.test(rest)) return { value, everywhere: true, quoted: true };
    return POLITE.test(rest) ? { value, everywhere: false, quoted: true } : null;
  }
  let value = stripQuotes(tail.replace(MARK, (_m, i: string) => `"${values[Number(i)]}"`));
  const scope = EVERYWHERE_AT_END.exec(value);
  if (scope) value = value.slice(0, scope.index).trim();
  return { value, everywhere: !!scope, quoted: false };
}

/**
 * An unquoted new text starts with a capital, as said ("rename this to pay now" \u2192 "Pay now"), unless its first word
 * is written with capitals of its own: "iOS", "eBay", "macOS" stay as they are.
 */
function capitalized(value: string): string {
  const first = value.split(/\s/)[0];
  return /\p{Lu}|\d/u.test(first.slice(1)) ? value : value[0].toUpperCase() + value.slice(1);
}

const words = (s: string) => ' ' + s.toLowerCase().replace(/[“”"‘’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

export function parseQuick(input: string): QuickIntent | null {
  const raw = input.trim();
  const { masked, values } = quoted(raw);
  const t = words(raw);
  // What is asked, without the names quoted in it.
  const asked = words(masked.replace(MARK, ' '));

  if (/\b(look|looks|style|styled)\s+(just\s+|exactly\s+)?like\b|\bsame (style|look|size|styling) as\b|\bmatch(es)?\b/.test(asked)) {
    const adjust = /\b(smaller|tinier|less)\b/.test(asked) ? -1 : /\b(bigger|larger)\b/.test(asked) ? 1 : 0;
    return { kind: 'copy', adjust };
  }

  // A rename first: its new text can have any words in it ("Remove", "Terms and conditions").
  const text =
    /\b(?:rename|relabel|call)\b.*?\b(?:to|as)\b\s+(.+)$/is.exec(masked) ??
    /\b(?:change|set|update|make)\s+(?:the\s+)?(?:text|label|copy|title|wording|words?)\b.*?\b(?:to|into)\b\s+(.+)$/is.exec(masked) ??
    /\b(?:make\s+(?:this|that|it)\s+)?(?:say|read)s?\s+(.+)$/is.exec(masked);
  if (text) {
    const found = newText(text[1], values);
    if (!found) return null;
    // "Rename all of them to …": what is renamed says so too.
    const everywhere = found.everywhere || EVERYWHERE.test(masked.slice(0, text.index + text[0].length - text[1].length).replace(MARK, ' '));
    if (found.value) return { kind: 'text', value: found.quoted ? found.value : capitalized(found.value), ...(everywhere ? { everywhere: true as const } : {}) };
  }

  // Two things asked at once ("bigger and red", "remove this and move that"): the AI does both, a quick edit only one.
  if (/\b(?:and|then|also|plus)\b/.test(asked)) return null;

  const move = /\b(move|put|place|drag)\b.*\b(above|below|before|after|under|over|beneath|underneath)\b/.exec(asked);
  if (move) return { kind: 'move', where: /^(below|after|under|beneath|underneath)$/.test(move[2]) ? 'below' : 'above' };

  const removes = removal(asked);
  if (removes === 'element') return { kind: 'remove' };
  // "Remove the border", "hide this on mobile": about the element, for the AI.
  if (removes === 'other') return null;

  const big = /\b(bigger|larger|huge|grow|taller|wider|increase)\b/.test(t);
  const small = /\b(smaller|tiny|tinier|shrink|shorter|narrower|decrease|compact)\b/.test(t);
  const spacing = /\b(padding|spacing|space|gap|gaps|room|airy|tighter|looser|roomier)\b/.test(t);
  if (big || small || /\b(more|less) (padding|spacing|space|room)\b/.test(t) || /\b(tighter|roomier|looser)\b/.test(t)) {
    const dir: 1 | -1 = big || /\b(more|looser|roomier)\b/.test(t) ? 1 : -1;
    const amount: 1 | 2 = /\b(much|a lot|way|lots|huge|tiny)\b/.test(t) ? 2 : 1;
    return { kind: 'step', dir, amount, focus: spacing ? 'spacing' : 'size' };
  }

  if (/\b(make|turn|set|change|switch|use|give)\b/.test(t) || t.trim().split(' ').length <= 3) {
    const terms = t.trim().split(' ').filter((w) => w && !STOP.has(w));
    if (terms.length && terms.length <= 4) return { kind: 'set', terms };
  }
  return null;
}
