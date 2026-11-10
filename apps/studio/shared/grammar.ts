/**
 * The small vocabulary that is handled instantly and offline. A request is a quick edit only when ALL of it is one of
 * the shapes below. A question, a condition (“on mobile”, “when the cart is empty”), a “don't”, a second thing asked,
 * or words the shapes have no place for send the whole request to the AI: a word like “bigger” or “says” somewhere
 * in a sentence is never enough, because a quick edit that guesses changes code nobody asked to change.
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
  'a an the this that these those it its to into as be is are was make makes made turn change set use using with please can you could would just look looks like more less bit little lot much way really so and also now then on in of for here there me my our your some kind sort apply give switch'.split(' '),
);

/** A request about more than the one element: "everywhere", "all of them", "on every page". */
const EVERYWHERE = /\b(?:everywhere|wherever|throughout|all of (?:them|these|those)|(?:all|every|each) (?:the )?(?:one|ones|instances?|occurrences?|places?|pages?|screens?|buttons?|links?|labels?|copies)|across the (?:app|site|page|pages|project))\b/i;
/** The same, closing an unquoted new text: "rename it to Place order everywhere it appears". */
const EVERYWHERE_AT_END = new RegExp(`\\s+(?:${EVERYWHERE.source})(?:\\s+(?:it|they)\\s+(?:appears?|shows?|is|are)(?:\\s+used)?)?[.!]*$`, 'i');
/** What may follow a quoted new text without asking for anything more. */
const POLITE = /^(?:please|thanks|thank you|instead|now|for me)?[.!]*$/i;
const MARK = /(\d+)/g;

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
  const verb = /^(?:remove|delete|get rid of|drop|hide)\b(.*)$/.exec(asked);
  if (!verb) return null;
  const rest = verb[1]
    .replace(/\b(?:entirely|completely|altogether)\b/g, ' ')
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
    return `${values.length - 1}`;
  });
  return { masked, values };
}

/**
 * The new text a rename asks for, whether it is for every place it appears, and whether it was quoted (then it is
 * taken exactly as written); null when more is asked of it than a rename.
 */
function newText(tail: string, values: string[]): { value: string; everywhere: boolean; quoted: boolean } | null {
  const lead = /^\s*(\d+)(.*)$/s.exec(tail);
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
 * An unquoted new text starts with a capital, as said ("rename this to pay now" → "Pay now"), unless its first word
 * is written with capitals of its own: "iOS", "eBay", "macOS" stay as they are.
 */
function capitalized(value: string): string {
  const first = value.split(/\s/)[0];
  return /\p{Lu}|\d/u.test(first.slice(1)) ? value : value[0].toUpperCase() + value.slice(1);
}

/** A request in lower case, without its punctuation and quotes: only its words, one space apart. */
const words = (s: string) => s.toLowerCase().replace(/[“”"‘’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();

/** Asking nicely is not asking for more: "can you", "please", "for me". */
const POLITE_LEAD = /^(?:(?:please|ok|okay|hey|now|just|kindly|can you|could you|would you|will you|i want you to|i would like you to|id like you to|lets)\s+)+/;
const POLITE_TAIL = /(?:\s+(?:please|thanks|thank you|now|for me|instead|here))+$/;
const NICELY = /^\s*(?:please\s+)?(?:can|could|would|will) you\b/i;
/**
 * How a question or a request for something else starts: none of these is a quick edit, whatever words follow. The
 * verbs of the shapes above are here too: by the time this is asked, their own shape has said no.
 */
const NOT_AN_EDIT =
  /^(?:why|what|whats|where|when|how|is|are|was|were|does|do|did|which|who|whose|should|shall|can|could|would|will|may|might|explain|tell|describe|show|check|test|find|search|list|count|help|debug|fix|add|create|insert|build|write|implement|refactor|wrap|replace|swap|duplicate|copy|clone|link|connect|validate|sort|filter|animate|call|open|go|undo|keep|dont|do not|never|stop|avoid|grow|enlarge|increase|expand|shrink|decrease|reduce|move|put|place|drag|rename|relabel)\b/;

/** What a reference to something on the page looks like: "this", "it", "that button", "the order total". */
const REF = '(?:this|that|it|these|those|them|(?:the|this|that|these|those) [a-z0-9-]+(?: [a-z0-9-]+){0,3})';
/** Words that start a condition, a place, a comparison or a second request: more than a quick edit does. */
const MORE_ASKED = 'when whenever if unless until while once because since only except than without not dont doesnt isnt cant wont shouldnt never no and or then also plus but after before on in at for as of by with from during via per';
const A_CLAUSE = new Set(MORE_ASKED.split(' '));
/**
 * Words a reference never holds ("the button when hovered", "this on mobile", "the price bigger than"): with one of
 * them, what looked like a name is the start of something else.
 */
const NOT_IN_REF = new Set(`${MORE_ASKED} to into is are was be gets get becomes has have should must will can so too very like same look looks more less bigger larger smaller`.split(' '));
const ref = (s: string | undefined) => !s || s.split(' ').every((w) => !NOT_IN_REF.has(w));
/** What "the X" can't be when something is to be renamed, moved or resized: these are code, or not things on the page. */
const NOT_ON_THE_PAGE = /\b(?:class|classname|css|id|ids|file|files|folder|function|method|variable|constant|component|prop|props|property|hook|handler|callback|listener|event|route|path|url|endpoint|api|key|type|interface|module|package|test|tests|state|focus|cursor|caret|scroll|logic|code|request|query|validation|timeout|delay|duration)\b/;

const DEGREE = '(?:(?:a bit|a little|a little bit|a tad|a touch|slightly|somewhat)|(much|a lot|way|lots|far|so much|really|a whole lot|significantly))';
const BIGGER = 'bigger|larger|huge|taller|wider';
const SMALLER = 'smaller|tinier|tiny|shorter|narrower|compact|more compact';
const ROOM = 'padding|spacing|space|room|gap|gaps|breathing room|whitespace|white space';

const COPY = [
  new RegExp(`^(?:(?:make|style|have) )?(?:(${REF}) )?(?:look|looks|be|be styled|styled) (?:just |exactly |more )?like (${REF})(?: but (?:a bit |a little |slightly |much )?(smaller|tinier|bigger|larger))?$`),
  new RegExp(`^(?:(?:make|give|have) )?(?:(${REF}) )?(?:use |have |get )?(?:the )?same (?:style|look|size|styling|design) as (${REF})()$`),
  new RegExp(`^(?:make )?(?:(${REF}) )?match(?:es)? (${REF})()$`),
];
const MOVE = new RegExp(`^(?:move|put|place|drag) (${REF}) (?:to )?(?:right |just |directly )?(above|below|before|after|under|over|beneath|underneath) (${REF})$`);
/** "make this bigger", "much smaller", "a bit bigger", "make the total larger". */
const STEP_ADJECTIVE = new RegExp(`^(?:(?:make|get|turn) )?(?:(${REF}) )?(?:look |be |appear )?(?:${DEGREE} )?(${BIGGER}|${SMALLER})$`);
/** "grow this", "shrink it", "increase the padding", "reduce the size of this". */
const STEP_VERB = new RegExp(`^(grow|enlarge|increase|expand|shrink|decrease|reduce)(?: (?:the |its )?(size|font size|text size|height|width|${ROOM}))?(?: (?:of |on |for |around |in )?(${REF}))?(?: (?:${DEGREE}))?$`);
/** "more padding", "less spacing", "give it more room", "a bit more space around this". */
const STEP_ROOM = new RegExp(`^(?:(?:add|give|use|make|get|put|have) )?(?:(${REF}) )?(?:have |get )?(?:${DEGREE} )?(more|extra|additional|some|some more|bigger|larger|less|smaller|tighter|looser) (?:${ROOM})(?: (?:around|inside|in|on|to|for|within) (${REF}))?$`);
/** "tighter", "make it roomier". */
const STEP_AIR = new RegExp(`^(?:(?:make|get) )?(?:(${REF}) )?(?:${DEGREE} )?(tighter|denser|looser|roomier|airier|more spacious)$`);

/** Parts and states of an element, not values of its design-system props: "a red border", "bold on hover". */
const A_PART = new Set('border borders shadow shadows background bg corner corners radius underline margin margins hover focus animation transition tooltip placeholder opacity gradient width height font'.split(' '));
/** What a request to set a value may say beside the value: the kind of thing it is. */
const KIND_OF_VALUE = new Set('variant style tone color colour size look one version theme'.split(' '));
/** Values that are a look, not a label: "set the title to bold" asks for bold, not for the word. */
const A_LOOK = new Set(
  'bold bolder italic underlined uppercase lowercase capitalized centered hidden visible disabled enabled primary secondary tertiary ghost outline danger success warning info default small smaller medium large larger big bigger red green blue yellow orange purple pink black white gray grey dark light'.split(' '),
);

/**
 * A rename: its new text can have any words in it ("Remove", "Terms and conditions"), so it is read first and from the
 * request as written. `undefined`: not a rename at all. `null`: a rename that asks for more than a quick edit does.
 */
function rename(masked: string, values: string[]): QuickIntent | null | undefined {
  const s = masked.trim().replace(/^(?:(?:please|ok|okay|hey|now|just|kindly|can you|could you|would you|will you)\s+)+/i, '');
  // What is renamed, when it is named: the element ("this", "the Pay button", a quoted name), or all of them.
  const subject = (said: string): boolean | 'everywhere' => {
    const what = words(said.replace(MARK, ' quoted '));
    if (!what || /^(?:(?:the|this|that) )?quoted(?: (?:button|link|label|heading|title|tab|item|badge|text))?$/.test(what)) return true;
    if (EVERYWHERE.test(what)) return 'everywhere';
    return new RegExp(`^${REF}$`).test(what) && ref(what) && !NOT_ON_THE_PAGE.test(what);
  };
  let about: boolean | 'everywhere' = true;
  let tail: string | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^(?:rename|relabel)\b(.*?)\b(?:to|as)\b\s+(.+)$/is.exec(s))) {
    about = subject(m[1]);
    tail = m[2];
  } else if (/^(?:rename|relabel)\b/i.test(s)) return null;
  else if ((m = /^call\s+(?:it|this|that|them)\s+(.+)$/is.exec(s))) tail = m[1];
  else if ((m = /^(?:change|set|update|make|edit)\s+(?:(?:the|its|this|that)\s+)?(?:text|label|copy|title|wording|words?|caption)\b(.*?)\b(?:to|into|say|read)\b\s+(.+)$/is.exec(s))) {
    // "the label of this", "the text on every page": anything else in between ("the label colour to red") isn't a rename.
    const between = words(m[1].replace(MARK, ' quoted '));
    about = !between || /^(?:here|of quoted)$/.test(between) ? true : EVERYWHERE.test(between) ? 'everywhere' : new RegExp(`^(?:of|on|in|for) ${REF}$`).test(between) && ref(between.replace(/^\w+ /, ''));
    tail = m[2];
    // "Set the title to bold" asks for a look, not for the word "Bold".
    const value = words(tail);
    if (!tail.includes('\uE000') && value.split(' ').length <= 2 && value.split(' ').every((w) => A_LOOK.has(w))) return null;
  } else if ((m = new RegExp(`^(?:make|have)\\s+(${REF})\\s+(?:say|read)s?\\s+(.+)$`, 'is').exec(s)) && ref(m[1].toLowerCase()) && !NOT_ON_THE_PAGE.test(m[1].toLowerCase())) tail = m[2];
  else if ((m = /^say\s+(.+)$/is.exec(s))) tail = m[1];
  else if ((m = new RegExp(`^(${REF})\\s+should\\s+(?:say|read)\\s+(.+)$`, 'is').exec(s)) && ref(m[1].toLowerCase()) && !NOT_ON_THE_PAGE.test(m[1].toLowerCase())) tail = m[2];
  if (tail === undefined) return undefined;
  if (!about) return null;
  const found = newText(tail, values);
  if (!found || !found.value) return null;
  const everywhere = found.everywhere || about === 'everywhere';
  return { kind: 'text', value: found.quoted ? found.value : capitalized(found.value), ...(everywhere ? { everywhere: true as const } : {}) };
}

export function parseQuick(input: string): QuickIntent | null {
  const raw = input.trim();
  if (!raw) return null;
  const { masked, values } = quoted(raw);

  const text = rename(masked, values);
  if (text !== undefined) return text;

  // A question is answered, never acted on ("is this bigger than 44 pixels?"); "can you make this bigger?" is a request.
  if (/\?\s*$/.test(raw) && !NICELY.test(raw)) return null;
  // What is asked, without the names quoted in it and without the asking nicely.
  const asked = words(masked.replace(MARK, ' ')).replace(POLITE_LEAD, '').replace(POLITE_TAIL, '');
  if (!asked) return null;

  for (const shape of COPY) {
    const m = shape.exec(asked);
    if (m && ref(m[1]) && ref(m[2])) return { kind: 'copy', adjust: /smaller|tinier/.test(m[3] ?? '') ? -1 : m[3] ? 1 : 0 };
  }

  // Two things asked at once ("bigger and red", "remove this and move that"): the AI does both, a quick edit only one.
  if (/\b(?:and|then|also|plus)\b/.test(asked)) return null;

  const move = MOVE.exec(asked);
  if (move) return ref(move[1]) && ref(move[3]) && !NOT_ON_THE_PAGE.test(move[1]) ? { kind: 'move', where: /^(below|after|under|beneath|underneath)$/.test(move[2]) ? 'below' : 'above' } : null;

  const removes = removal(asked);
  if (removes === 'element') return { kind: 'remove' };
  // "Remove the border", "hide this on mobile": about the element, for the AI.
  if (removes === 'other') return null;

  const step = stepOf(asked);
  if (step) return step;

  // A value can be named by a word that is also a verb (a "link" variant): alone, it is the value.
  if (asked.includes(' ') && NOT_AN_EDIT.test(asked)) return null;
  return setOf(asked);
}

/** A step up or down a size or spacing scale, when that is the whole request. */
function stepOf(asked: string): QuickIntent | null {
  let m = STEP_ADJECTIVE.exec(asked);
  if (m) {
    if (!ref(m[1]) || NOT_ON_THE_PAGE.test(m[1] ?? '')) return null;
    const word = m[3];
    return { kind: 'step', dir: new RegExp(`^(?:${BIGGER})$`).test(word) ? 1 : -1, amount: m[2] || word === 'huge' || word === 'tiny' ? 2 : 1, focus: 'size' };
  }
  if ((m = STEP_VERB.exec(asked))) {
    if (!ref(m[3]) || NOT_ON_THE_PAGE.test(m[3] ?? '')) return null;
    // "Increase the total" may be about the number: without "the size of", only "this" and "it" are grown or shrunk.
    if (!m[2] && m[3] && !/^(?:this|that|it|these|those|them)$/.test(m[3])) return null;
    return { kind: 'step', dir: /^(?:grow|enlarge|increase|expand)$/.test(m[1]) ? 1 : -1, amount: m[4] ? 2 : 1, focus: m[2] && new RegExp(`^(?:${ROOM})$`).test(m[2]) ? 'spacing' : 'size' };
  }
  if ((m = STEP_ROOM.exec(asked))) {
    if (!ref(m[1]) || !ref(m[4])) return null;
    return { kind: 'step', dir: /^(?:less|smaller|tighter)$/.test(m[3]) ? -1 : 1, amount: m[2] ? 2 : 1, focus: 'spacing' };
  }
  if ((m = STEP_AIR.exec(asked))) {
    if (!ref(m[1])) return null;
    return { kind: 'step', dir: /^(?:tighter|denser)$/.test(m[3]) ? -1 : 1, amount: m[2] ? 2 : 1, focus: 'spacing' };
  }
  return null;
}

/**
 * A value of one of the component's own props, named outright: "make it red", "make the total bold", "set it to
 * large", "use the danger variant", or the value alone ("ghost"). The words are matched against the design system
 * later; here the request only has to be nothing but that.
 */
function setOf(asked: string): QuickIntent | null {
  const tokens = asked.split(' ');
  const verb = /^(?:make|turn|set|change|switch|use|apply|give)$/.test(tokens[0]);
  if (!verb && tokens.length > 3) return null;
  if (tokens.length > 8) return null;
  // With "to", the value is what follows it: in "set the default to express" nothing is to become "default".
  const to = Math.max(tokens.lastIndexOf('to'), tokens.lastIndexOf('into'));
  const about = to >= 0 ? tokens.slice(verb ? 1 : 0, to) : [];
  const value = to >= 0 ? tokens.slice(to + 1) : tokens.slice(verb ? 1 : 0);
  // A condition, a place, a part of it ("a red border") or a second thing: more than setting a value.
  const more = (w: string) => A_CLAUSE.has(w) || A_PART.has(w);
  if (about.some(more) || value.some(more)) return null;
  const terms = value.filter((w) => w && !STOP.has(w) && !KIND_OF_VALUE.has(w));
  return terms.length && terms.length <= 4 ? { kind: 'set', terms } : null;
}
