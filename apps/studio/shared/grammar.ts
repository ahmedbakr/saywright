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

function stripQuotes(s: string): string {
  return s.replace(/^[\s"“'‘]+|[\s"”'’.!?]+$/g, '');
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

/** The new text a rename asks for, and whether it is for every place it appears; null when more is asked of it than a rename. */
function newText(tail: string, values: string[]): { value: string; everywhere: boolean } | null {
  const lead = /^\s*\uE000(\d+)\uE000(.*)$/s.exec(tail);
  if (lead) {
    const value = values[Number(lead[1])].trim();
    const rest = lead[2].replace(MARK, (_m, i: string) => values[Number(i)]).trim();
    if (EVERYWHERE.test(rest)) return { value, everywhere: true };
    return POLITE.test(rest) ? { value, everywhere: false } : null;
  }
  let value = stripQuotes(tail.replace(MARK, (_m, i: string) => `"${values[Number(i)]}"`));
  const scope = EVERYWHERE_AT_END.exec(value);
  if (scope) value = value.slice(0, scope.index).trim();
  return { value, everywhere: !!scope };
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

  const move = /\b(move|put|place|drag)\b.*\b(above|below|before|after|under|over|beneath|underneath)\b/.exec(asked);
  if (move) return { kind: 'move', where: /^(below|after|under|beneath|underneath)$/.test(move[2]) ? 'below' : 'above' };

  if (/\b(remove|delete|get rid of|drop|hide)\b/.test(asked)) return { kind: 'remove' };

  const text =
    /\b(?:rename|relabel|call)\b.*?\b(?:to|as)\b\s+(.+)$/is.exec(masked) ??
    /\b(?:change|set|update|make)\s+(?:the\s+)?(?:text|label|copy|title|wording|words?)\b.*?\b(?:to|into)\b\s+(.+)$/is.exec(masked) ??
    /\b(?:make\s+(?:this|that|it)\s+)?(?:say|read)s?\s+(.+)$/is.exec(masked);
  if (text) {
    const found = newText(text[1], values);
    if (!found) return null;
    // "Rename all of them to …": what is renamed says so too.
    const everywhere = found.everywhere || EVERYWHERE.test(masked.slice(0, text.index + text[0].length - text[1].length).replace(MARK, ' '));
    if (found.value) return { kind: 'text', value: found.value[0].toUpperCase() + found.value.slice(1), ...(everywhere ? { everywhere: true as const } : {}) };
  }

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
