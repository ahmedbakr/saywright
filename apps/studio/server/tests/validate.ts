/**
 * What a test is written from, checked where it comes in (the studio's page, an agent, a script): every step and every
 * check as the test will hold them, or a refusal that names the one that is wrong and why. Nothing is cut short or
 * left out: a test written from part of what was asked for would pass without checking the rest.
 */
import type { Expectation, RecordedStep } from '../../shared/api.ts';
import { HttpError } from '../http.ts';
import { safeLocator } from './generate.ts';

/** The most a test may hold: past that it is too long to follow, run or fix, and is better split into shorter tests. */
export const MAX_STEPS = 1000;
export const MAX_CHECKS = 100;
/** Options chosen in one list. */
const MAX_OPTIONS = 1000;

const KINDS: readonly RecordedStep['kind'][] = ['click', 'fill', 'press', 'goto', 'note', 'url'];
const FIELDS: readonly NonNullable<Expectation['field']>[] = ['value', 'select', 'checked'];
/** Steps that act on an element, and so need one to act on. */
const ON_ELEMENT = new Set<RecordedStep['kind']>(['click', 'fill', 'press']);
/** Words and names: a locator, a description, a key. What was typed or should show can be as long as a request. */
const SHORT = 2000;
const URL_MAX = 8000;

const refuse = (message: string) => new HttpError(400, message);
const many = (n: number) => n.toLocaleString('en-US');
const shown = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

type Raw = Record<string, unknown>;

function record(v: unknown, what: string, shape: string): Raw {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw refuse(`${what} isn’t ${shape}.`);
  return v as Raw;
}

/** A text field: missing (or null) is undefined unless it is needed; anything but a string is refused. */
function text(o: Raw, key: string, what: string, opts: { needed?: string; max?: number } = {}): string | undefined {
  const v = o[key];
  if (v === undefined || v === null || (opts.needed && typeof v === 'string' && !v.trim())) {
    if (opts.needed) throw refuse(`${what} ${opts.needed}.`);
    return undefined;
  }
  if (typeof v !== 'string') throw refuse(`${what}: ${key} must be text, not ${shown(v)}.`);
  if (opts.max !== undefined && v.length > opts.max) throw refuse(`${what}: ${key} is longer than ${many(opts.max)} characters.`);
  return v;
}

function texts(o: Raw, key: string, what: string): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw refuse(`${what}: ${key} must be a list of texts.`);
  if (v.length > MAX_OPTIONS) throw refuse(`${what}: ${key} has more than ${many(MAX_OPTIONS)} entries.`);
  return v as string[];
}

function locator(o: Raw, what: string, needed: string): string {
  const code = text(o, 'locator', what, { needed, max: SHORT })!;
  try {
    return safeLocator(code);
  } catch {
    throw refuse(`${what}: “${shown(code)}” isn’t a locator a test can use. It must be page.getBy…(…) or page.locator(…), with text, numbers and flat options as arguments.`);
  }
}

function step(v: unknown, i: number): RecordedStep {
  const what = `Step ${i + 1}`;
  const o = record(v, what, 'a step (an object with a kind and a description)');
  const kind = o.kind as RecordedStep['kind'];
  if (!KINDS.includes(kind)) throw refuse(`${what} is “${shown(o.kind)}”, which a test can’t do: a step is one of ${KINDS.join(', ')}.`);
  const out: RecordedStep = { kind, description: text(o, 'description', what, { needed: 'says nothing about what it does (description)', max: SHORT })! };
  if (ON_ELEMENT.has(kind)) out.locator = locator(o, what, `(${kind}) names no element to ${kind === 'fill' ? 'fill' : kind} (locator)`);
  const url = text(o, 'url', what, { max: URL_MAX, ...(kind === 'goto' || kind === 'url' ? { needed: `(${kind}) names no address (url)` } : {}) });
  if (url !== undefined) out.url = url;
  const key = text(o, 'key', what, { max: 100 });
  if (key !== undefined) out.key = key;
  if (kind !== 'fill') return out;
  const value = text(o, 'value', what);
  if (value !== undefined) out.value = value;
  const secret = text(o, 'secret', what, { max: 100 });
  if (secret) out.secret = secret;
  const select = texts(o, 'select', what);
  if (select) out.select = select;
  const values = texts(o, 'values', what);
  if (values) out.values = values;
  for (const flag of ['checked', 'byValue'] as const) {
    const v = o[flag];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') throw refuse(`${what}: ${flag} must be true or false, not ${shown(v)}.`);
    out[flag] = v;
  }
  if (out.byValue && !out.values?.length) throw refuse(`${what} chooses by value, and names no values.`);
  return out;
}

function check(v: unknown, i: number, steps: number): Expectation {
  const what = `Check ${i + 1}`;
  const o = record(v, what, 'a check (an object with a locator, a description and what it should show)');
  const field = o.field === undefined || o.field === null ? undefined : (o.field as Expectation['field']);
  if (field !== undefined && !FIELDS.includes(field)) throw refuse(`${what} is about “${shown(o.field)}”, which a check can’t read: it reads the text, or a field’s value, select or checked.`);
  const out: Expectation = {
    locator: locator(o, what, 'names no element to check (locator)'),
    description: text(o, 'description', what, { needed: 'says nothing about what it checks (description)', max: SHORT })!,
    expected: text(o, 'expected', what, { needed: 'says nothing it should show (expected)' })!,
    actual: text(o, 'actual', what) ?? '',
  };
  if (field) out.field = field;
  if (field === 'checked' && out.expected !== 'checked' && out.expected !== 'not checked') throw refuse(`${what} is about whether it is checked, so it should be “checked” or “not checked”, not “${shown(out.expected)}”.`);
  if (o.after !== undefined && o.after !== null) {
    const after = o.after;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw refuse(`${what}: after must be how many steps come before it (a whole number), not ${shown(after)}.`);
    if (after > steps) throw refuse(`${what} comes after step ${many(after)}, and the test has ${many(steps)}.`);
    out.after = after;
  }
  return out;
}

/** Steps as a test holds them, all of them, or a refusal: too many to be one test, or one that can't be written. */
export function validSteps(raw: unknown): RecordedStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw refuse('steps must be a list of steps.');
  if (raw.length > MAX_STEPS) throw refuse(`A test can have at most ${many(MAX_STEPS)} steps, and this one has ${many(raw.length)}: nothing was written. Split it into shorter tests.`);
  return raw.map(step);
}

/** Checks as a test holds them, each after the steps it was said after: all of them, or a refusal. */
export function validChecks(raw: unknown, steps: number): Expectation[] {
  if (!Array.isArray(raw) || !raw.length) throw refuse('Say what you expected first');
  if (raw.length > MAX_CHECKS) throw refuse(`A test can have at most ${many(MAX_CHECKS)} checks, and this one has ${many(raw.length)}: nothing was written. Split it into shorter tests.`);
  return raw.map((c, i) => check(c, i, steps));
}
