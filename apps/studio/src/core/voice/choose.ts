/**
 * Picking what you said. The browser's recogniser and the on-device model
 * each propose transcripts; the on-device model then scores every proposal
 * against the actual audio. The winner balances that score with the browser's
 * own ranking, with whether the studio understands the phrase, and with signs
 * that one engine cut off the start or end of the sentence.
 *
 * When nothing heard makes sense and the utterance was short, the audio is
 * also scored against the studio's short commands. The thresholds below come
 * from 650 synthesised utterances (7 voices; clean, noisy and quiet): where
 * this rescue runs, it recovered 106 of 116 spoken commands and never fired
 * for the 32 utterances that weren't commands.
 */
import { parseQuick } from '@shared/grammar';
import { parseClientCommand, parseExpectation } from '../commands';
import type { Word } from './speech';

export type CandidateSource = 'browser' | 'device' | 'command' | 'variant';

export interface Candidate {
  text: string;
  source: CandidateSource;
  /** Position in the browser's list of alternatives (0 = its best guess). */
  rank: number;
  /** A variant: the transcript it was made from. */
  from?: Candidate;
}

/**
 * Short phrases scored against the audio when an utterance is brief: free
 * decoding is weakest there. ("Yes" and "no" are left out: one syllable
 * sounds like too many other words. "Reload" is too: it matched sentences
 * that weren't commands.)
 */
export const SHORT_COMMANDS = [
  'Keep it.',
  'Keep.',
  'Looks good.',
  'Undo.',
  'Undo that.',
  'Go back.',
  'Cancel.',
  'Stop.',
  'Never mind.',
  'Fix it.',
  'Run the test.',
  'Generate a test.',
  'Scroll down.',
  'Scroll up.',
  'Select parent.',
  'Clear.',
  'Help.',
  'Click this.',
];

export const tokens = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9$.' ]/g, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Same words, ignoring case and punctuation. */
export const sameWords = (a: string, b: string): boolean => tokens(a).join(' ') === tokens(b).join(' ');

/** What speech models tend to "hear" in breaths, coughs and background noise. */
const FILLERS = new Set(['you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'bye', 'bye bye', 'hmm', 'mm', 'mhm', 'uh', 'um', 'oh', 'ah', 'huh', 'the', 'a', 'i']);
/** Mean log-probability below which an on-device transcript is a guess. */
const DEVICE_MIN = -1.2;
/** …and the bar when the browser heard nothing at all (probably not speech). */
const DEVICE_MIN_ALONE = -0.8;
/** A sound-alike variant must explain the audio about as well as the transcript it came from. */
const VARIANT_SLACK = 0.8;
/** A rescued command must explain the audio at least this well… */
const COMMAND_MIN = -2.8;
/** …or this well when what was heard also sounds like it ("and you" for "undo"). */
const COMMAND_MIN_ALIKE = -3.5;
/** …and clearly better than any command that would do something else. */
const COMMAND_MARGIN = 0.4;

/** Whether an on-device transcript looks like real words rather than noise. */
export function plausible(text: string, score = 0, alone = false): boolean {
  const t = tokens(text);
  if (!t.length || FILLERS.has(t.join(' '))) return false;
  // Decoding loops ("the the the the") are a sign of noise.
  if (t.length >= 4 && new Set(t).size / t.length < 0.5) return false;
  return score >= (alone ? DEVICE_MIN_ALONE : DEVICE_MIN);
}

/** True when `short` is `long` with words missing at the start or the end (a clipped recording). Words are compared by sound. */
export function isClipped(short: string, long: string): boolean {
  const a = tokens(short).map(soundKey);
  const b = tokens(long).map(soundKey);
  if (!a.length || b.length <= a.length) return false;
  const joined = a.join(' ');
  return b.slice(b.length - a.length).join(' ') === joined || b.slice(0, a.length).join(' ') === joined;
}

/** Words that name a style value (a colour, size, variant…): "make it red", "make this the primary button". */
const STYLE_WORDS = new Set(
  'red orange amber yellow lime green emerald teal cyan blue indigo violet purple pink rose gray grey black white dark light primary secondary tertiary ghost outline outlined solid subtle soft link danger destructive success warning error info neutral muted accent bold italic underline small medium large tiny huge sm md lg xl rounded round square pill full wide narrow centered center left right disabled hidden visible'.split(' '),
);

/** The studio's own words, for swapping back in when a recogniser heard a sound-alike. */
const VOCABULARY = new Set([
  ...STYLE_WORDS,
  ...'bigger smaller larger wider taller shorter tighter looser more less rename remove delete hide move change make undo keep cancel stop scroll select parent reload help click padding spacing space gap text label title button above below test fix pin this that'.split(' '),
]);

/**
 * How a word sounds, roughly: consonants only, with voiced and voiceless
 * pairs (b/p, d/t, g/k, v/f, z/s) merged. Vowels and p/b are what non-native
 * speakers and recognisers most often get "wrong": "beggar", "baker" and
 * "bigger" all sound alike here, as do "read" and "red".
 */
export function soundKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  w = w
    .replace(/^kn/, 'n')
    .replace(/^wr/, 'r')
    .replace(/ph/g, 'f')
    .replace(/gh/g, '')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k');
  const lead = /^[aeiouy]/.test(w) ? 'a' : '';
  w = w
    .replace(/[aeiouyhw]/g, '')
    .replace(/b/g, 'p')
    .replace(/d/g, 't')
    .replace(/[gj]/g, 'k')
    .replace(/v/g, 'f')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');
  return lead + w;
}

const BY_SOUND = new Map<string, string[]>();
for (const word of VOCABULARY) if (word.length >= 3) BY_SOUND.set(soundKey(word), [...(BY_SOUND.get(soundKey(word)) ?? []), word]);

/**
 * Copies of a transcript with its last word swapped for a studio word that
 * sounds the same ("make it read" → "make it red", "cape" → "keep"). Only
 * where the studio expects one of its words: a one-word command, or the
 * value at the end of "make it …".
 */
export function soundAlikes(text: string): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length > 1 && !/^(make|turn|set|change)$/i.test(words[0])) return [];
  const m = /^([^A-Za-z']*)([A-Za-z']+)(.*)$/.exec(words[words.length - 1]);
  if (!m || m[2].length < 3 || VOCABULARY.has(m[2].toLowerCase())) return [];
  return (BY_SOUND.get(soundKey(m[2])) ?? []).map((word) => {
    const cased = m[2][0] === m[2][0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
    return [...words.slice(0, -1), m[1] + cased + m[3]].join(' ');
  });
}

/** Whether the studio knows what to do with a phrase. */
export function understood(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (parseClientCommand(t, { hasFailingTest: true })) return true;
  if (parseExpectation(t)) return true;
  if (/^(why|what|where|when|how|can|could|is|are|does|do|should|which|who)\b/i.test(t)) return true;
  const q = parseQuick(t);
  if (!q) return false;
  // A "set" is a guess unless it names a style value ("make this figure" is not one).
  return q.kind !== 'set' || q.terms.some((term) => STYLE_WORDS.has(term));
}

const action = (text: string): string => {
  const c = parseClientCommand(text, { hasFailingTest: true });
  return c ? `${c.kind}${'dir' in c ? c.dir : ''}` : '';
};

/** A short transcript that, run together, sounds like a command ("and you" → "undo"). */
export function soundsLike(heard: string, command: string): boolean {
  const merged = (t: string) => soundKey(tokens(t).join(''));
  return tokens(heard).length <= 3 && merged(heard).length >= 2 && merged(heard) === merged(command);
}

/**
 * The short commands the model scored against the audio, as candidates: every one but those a recogniser heard as
 * they are. A command that is also a sound-alike made from what was heard (“Andi.” gives “Undo.”) is weighed as a
 * command too: a variant must explain the audio about as well as the transcript it came from, which a command the
 * model couldn't transcribe never does.
 */
export function commandCandidates(candidates: Candidate[], scored: Record<string, number>): Candidate[] {
  return Object.keys(scored)
    .filter((text) => !candidates.some((c) => c.text === text && c.source !== 'variant'))
    .map((text) => ({ text, source: 'command', rank: 0 }));
}

/** The short command the audio clearly is, if any. */
function rescued(commands: Candidate[], scores: Record<string, number>, heard: Candidate[]): Candidate | null {
  const ranked = commands.filter((c) => scores[c.text] !== undefined).sort((a, b) => scores[b.text] - scores[a.text]);
  const best = ranked[0];
  if (!best) return null;
  const alike = heard.some((h) => soundsLike(h.text, best.text));
  if (scores[best.text] < (alike ? COMMAND_MIN_ALIKE : COMMAND_MIN)) return null;
  const rival = ranked.find((c) => action(c.text) !== action(best.text));
  return rival && scores[best.text] - scores[rival.text] < COMMAND_MARGIN ? null : best;
}

/**
 * Choose the best candidate. `scores` are the on-device model's mean
 * log-probabilities keyed by candidate text (null when it isn't available).
 */
export function pick(candidates: Candidate[], scores: Record<string, number> | null): Candidate | null {
  const pool = candidates.filter((c) => c.text.trim());
  if (!pool.length) return null;
  const browserTop = pool.find((c) => c.source === 'browser' && c.rank === 0) ?? null;
  if (!scores) {
    // Browser only: its best guess, unless a lower-ranked alternative is the one that makes sense.
    const browser = pool.filter((c) => c.source === 'browser');
    return browser.find((c) => understood(c.text)) ?? browser[0] ?? null;
  }
  const command = rescued(
    pool.filter((c) => c.source === 'command'),
    scores,
    pool.filter((c) => c.source === 'browser' || c.source === 'device'),
  );
  if (command) return command;
  /** What a transcript has going for it besides the model's score. */
  const standing = (c: Candidate): number => {
    if (c.source === 'browser') return c.rank === 0 ? 1.0 : 0.3;
    // The browser starts listening late and stops on release: prefer the fuller transcript.
    if (c.source === 'device' && browserTop && isClipped(browserTop.text, c.text)) return 1.2;
    return 0;
  };
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  for (const c of pool) {
    const s = scores[c.text];
    if (s === undefined || c.source === 'command') continue;
    let total = s;
    if (c.source === 'variant') {
      // A sound-alike counts only if it makes sense and the audio supports it about as well.
      const base = c.from ? scores[c.from.text] : undefined;
      if (!c.from || base === undefined || s < base - VARIANT_SLACK || !understood(c.text)) continue;
      total += standing(c.from);
    } else total += standing(c);
    // A phrase the studio understands beats noise the model happened to like.
    if (understood(c.text)) total += 1.0;
    if (total > bestScore) {
      bestScore = total;
      best = c;
    }
  }
  return best ?? browserTop;
}

/**
 * Word timings spread across the stretch of audio that contained speech, so
 * "this" and "that" can be matched to where you were pointing as you said them.
 */
export function alignWords(text: string, start: number, end: number): Word[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const total = words.reduce((n, w) => n + w.length, 0) + words.length - 1;
  const span = Math.max(1, end - start);
  let at = 0;
  return words.map((w) => {
    const mid = (at + w.length / 2) / Math.max(1, total);
    at += w.length + 1;
    return { text: w, t: start + mid * span };
  });
}


/**
 * Pick between the browser's recogniser and the studio's own (server) model
 * for Arabic, where there are no model scores to weigh. A transcript the
 * studio understands as a command wins (the browser's spelling when both
 * agree); the server's when the browser missed the start (it starts late, the
 * server has the audio from before the press); otherwise the browser's.
 */
export function chooseWithoutScores(browser: string[], local: string, understands: (text: string) => boolean): { text: string; source: 'browser' | 'device' } | null {
  const web = browser.filter((t) => t.trim());
  const dev = local.trim();
  if (!web.length && !dev) return null;
  if (!web.length) return { text: dev, source: 'device' };
  if (!dev) return { text: web[0], source: 'browser' };
  if (understands(web[0])) return { text: web[0], source: 'browser' };
  if (understands(dev)) return { text: dev, source: 'device' };
  const lower = web.find((t) => understands(t));
  if (lower) return { text: lower, source: 'browser' };
  const a = words(web[0]);
  const b = words(dev);
  // The browser heard the end of what the server heard in full.
  if (b.length >= a.length + 2 && a.length && a.every((w, i) => sameish(w, b[b.length - a.length + i]))) return { text: dev, source: 'device' };
  return { text: web[0], source: 'browser' };
}

function words(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function sameish(a: string, b: string | undefined): boolean {
  if (!b) return false;
  if (a === b) return true;
  const fold = (s: string) => s.replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  return fold(a) === fold(b);
}
