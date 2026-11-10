/**
 * Spoken or typed phrases the studio handles itself, without the server:
 * deciding on previews, navigating the selection, switching modes, driving the
 * test recorder. Everything else is a request for a change.
 */
import { cutSaid, spokenMoney } from '@shared/expected';

export type Mode = 'edit' | 'use' | 'record';

export type ClientCommand =
  | { kind: 'keep' }
  | { kind: 'undo' }
  | { kind: 'cancel' }
  | { kind: 'parent' }
  /** Move the selection inside it, or to the next or previous one. */
  | { kind: 'nav'; to: 'child' | 'next' | 'prev' }
  /** Select the nearest element called `what` ("the card", "the button inside"). */
  | { kind: 'find'; what: string; where: 'any' | 'out' | 'in' }
  | { kind: 'clear' }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'generate' }
  | { kind: 'run' }
  | { kind: 'fix' }
  | { kind: 'click' }
  | { kind: 'type'; text: string; submit: boolean }
  | { kind: 'scroll'; dir: 'up' | 'down' | 'top' | 'bottom' }
  | { kind: 'reload' }
  | { kind: 'help' }
  | { kind: 'open' }
  | { kind: 'select' }
  /** Add what you point at to the selection (or take it out): for “make this look like that”. */
  | { kind: 'add' };

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'$.\s-]/g, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(ok|okay|hey|um|uh|so|and|now|please|alright|all right)\s+/, '')
    .replace(/\s+(please|thanks|thank you|now)$/, '')
    .trim();
}

/** Parts of a page, as people name them. */
const PART =
  '(?:card|button|link|image|picture|photo|icon|logo|heading|title|header|footer|form|list|item|row|field|input|menu|navbar|nav|section|table|price|label|text|paragraph|dialog|modal|sidebar|banner|badge|avatar|tab|panel|box|cell|column|chart|summary|total)s?';

const TABLE: [RegExp, ClientCommand | ((m: RegExpExecArray) => ClientCommand)][] = [
  [/^(keep|keep (it|that|this|them|both|all|these|those|the changes?)|looks (good|great)|ship it|accept( it| that)?|approve( it)?|perfect|that's (good|great|it)|yes|yeah|yep|yes keep( it)?|lgtm)$/, { kind: 'keep' }],
  [/^(undo|undo (it|that|this|the change)|revert( it| that)?|go back|discard( it| that)?|nope|no|reject( it| that)?|take (it|that) back|put it back)$/, { kind: 'undo' }],
  [/^(cancel|stop|never ?mind|forget (it|that)|abort)$/, { kind: 'cancel' }],
  [/^((select )?(the )?parent|go up( a level| one level)?|(go |one )?(level )?up one level|select (the )?(container|wrapper)|(go |select )?outside( it| this)?|zoom out)$/, { kind: 'parent' }],
  [/^((select |go )?(inside|in)( it| this| one level)?|go down( a level| one level)|one level down|(select |pick )?(the )?(child|first child|inner (one|element|part)|one inside|thing inside)|zoom in)$/, { kind: 'nav', to: 'child' }],
  [/^((select |pick |go to )?(the )?next( one| sibling| item| element| card| row)?)$/, { kind: 'nav', to: 'next' }],
  [/^((select |pick |go to )?(the )?(previous|prev|one before)( one| sibling| item| element| card| row)?)$/, { kind: 'nav', to: 'prev' }],
  [/^(clear|clear (the )?(pins|selection|all|everything)|deselect( all| everything| it| this| that)?|unselect( it| this| that| all)?|unpin( all| everything)?|select nothing)$/, { kind: 'clear' }],
  // The record mode is called “Write test” on screen.
  [/^(start recording|record( a bug| this)?|(switch to |go to )?(record|write( a)? test) mode)$/, { kind: 'mode', mode: 'record' }],
  [/^((stop recording)|(switch to |go to )?edit mode|edit)$/, { kind: 'mode', mode: 'edit' }],
  [/^((switch to |go to )?use mode|use the app|let me use (it|the app)|interact)$/, { kind: 'mode', mode: 'use' }],
  [/^((generate|make|write|create|save)( me)?( a| the)? (test|spec|playwright test)|turn (this|that|it) into a test)$/, { kind: 'generate' }],
  [/^((run|rerun|re-run|try)( the| that| this| my)? (test|spec)( again)?|run it( again)?|test it)$/, { kind: 'run' }],
  [/^(fix (it|this|that|the bug|this bug|that bug|the test|the failure)( please)?)$/, { kind: 'fix' }],
  [/^((click|press|tap|hit)( on)?( (this|that|it|here))?)$/, { kind: 'click' }],
  [/^scroll (up|down)( a bit| more)?$/, (m) => ({ kind: 'scroll', dir: m[1] as 'up' | 'down' })],
  [/^(scroll|go) to (the )?(top|bottom)$/, (m) => ({ kind: 'scroll', dir: m[3] as 'top' | 'bottom' })],
  [/^(reload|refresh)( the)?( app| page)?$/, { kind: 'reload' }],
  [/^(help|what can i (say|do)|show (me )?(the )?(help|shortcuts|gestures|commands))$/, { kind: 'help' }],
  [/^((open|show)( (this|that|it))? in (the |my )?(editor|code|vs ?code|cursor)|show (me )?the code( for (this|that|it))?|go to (the )?code)$/, { kind: 'open' }],
  [/^select (this|that|it)$/, { kind: 'select' }],
  [/^((pin|add) (this|that|it)( too| as well| also| to (the )?selection)?|(select )?(this|that) too|(and|also) (this|that)( one)?|(this|that) as well)$/, { kind: 'add' }],
  [/^(?:select|pick|choose|grab|highlight) (?:the )?(?!(?:this|that|it|all|everything|nothing|none)$)([a-z][a-z -]{1,24}?)(?: (inside it|inside this|inside|in it|in this|around it|around this|outside it|outside))?(?: instead)?$/, findOf],
  // Without “select”, only what pages are made of (“the card”), so ordinary sentences stay requests.
  [new RegExp(`^the ((?:[a-z]+ )?${PART})(?: (inside it|inside|in it|around it|outside|instead))?$`), findOf],
  [new RegExp(`^(?:the )?(${PART}) (inside)$`), findOf],
];

function findOf(m: RegExpExecArray): ClientCommand {
  const where = !m[2] || m[2] === 'instead' ? 'any' : /^(inside|in )/.test(m[2]) ? 'in' : 'out';
  return { kind: 'find', what: m[1].trim(), where };
}

export function parseClientCommand(text: string, opts: { hasFailingTest: boolean }): ClientCommand | null {
  // `type …` keeps the user's own casing and punctuation.
  const typeCmd = /^\s*type\s+(.+?)(?:\s+and\s+(?:press\s+|hit\s+)?(enter|submit|return))?[.!]?\s*$/i.exec(text);
  if (typeCmd) return { kind: 'type', text: typeCmd[1].replace(/^["“'‘]|["”'’]$/g, ''), submit: !!typeCmd[2] };
  const t = normalize(text);
  if (!t) return null;
  for (const [re, out] of TABLE) {
    const m = re.exec(t);
    if (!m) continue;
    const cmd = typeof out === 'function' ? out(m) : out;
    // "fix this" with nothing failing is an ordinary request for Claude.
    if (cmd.kind === 'fix' && !opts.hasFailingTest) return null;
    return cmd;
  }
  return null;
}

export interface SpokenExpectation {
  /** The word that names the element ("this", "the total"), when there is one. */
  subject: string | null;
  expected: string;
  /**
   * All the words said, when `expected` was cut from them at a “not” or a “but” (“Paid, not yet” → “Paid”): what the
   * check is about if the element already shows all of it.
   */
  whole?: string;
}

/**
 * "this should show $80.80", "the total should be 80.80 not 78.40", "this should show $64.64, not $51.71",
 * "it ought to say Free", "it should say “Item not found”". Used in Record mode to turn narration into a check.
 */
export function parseExpectation(text: string): SpokenExpectation | null {
  // "this shouldn't be checked", "it should not be ticked": a box that must be left clear.
  const off = /^(?:(?:but|and|so)\s+)?(?:(this|that|it|the [\w\s-]{1,30}?)\s+)?(?:should|must|ought to|is supposed to)\s*(?:not|n['’]t)\s+be\s+(?:checked|ticked|selected|chosen|on)[.!?]*$/i.exec(text.trim());
  if (off) return { subject: off[1]?.toLowerCase() ?? null, expected: 'not checked' };
  const m = /^(?:(?:but|and|so)\s+)?(?:(this|that|it|the [\w\s-]{1,30}?)\s+)?(?:should|must|needs to|ought to|is supposed to|has to)\s+(?:be|say|show|read|display|equal|contain|have|include)\s+(.+)$/is.exec(
    text.trim(),
  );
  if (!m) return null;
  const subject = m[1]?.toLowerCase() ?? null;
  // A quoted value is taken whole, whatever words are in it.
  const quoted = /^(?:"([^"]+)"|“([^”]+)”|‘([^’]+)’|'([^']+)'|«([^»]+)»)/.exec(m[2].trim());
  const inQuotes = quoted?.slice(1).find((x) => x !== undefined)?.trim();
  if (quoted) return inQuotes ? { subject, expected: inQuotes } : null;
  const all = m[2].replace(/[\s.,;:!?]+$/, '').trim();
  let expected = cutSaid(m[2]);
  // Speech often says "57.60 dollars" for "$57.60".
  const dollars = /^(\d+(?:[.,]\d{1,2})?)\s*(?:dollars|bucks|usd)$/i.exec(expected);
  if (dollars) expected = `$${dollars[1]}`;
  else expected = spokenMoney(expected) ?? expected;
  if (!expected) return null;
  return { subject, expected, ...(all.length > expected.length && cutSaid(all) !== all ? { whole: all } : {}) };
}
