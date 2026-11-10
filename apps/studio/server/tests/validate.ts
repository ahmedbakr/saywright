/**
 * What a test is written from, checked where it comes in (the studio's page, an agent, a script): every step and every
 * check as the test will hold them, or a refusal that names the one that is wrong and why. Nothing is cut short or
 * left out: a test written from part of what was asked for would pass without checking the rest.
 */
import type { StepDialog } from '@saywright/vite/protocol';
import type { Expectation, RecordedStep } from '../../shared/api.ts';
import { HttpError } from '../http.ts';
import { safeLocator } from './generate.ts';

/** The most a test may hold: past that it is too long to follow, run or fix, and is better split into shorter tests. */
export const MAX_STEPS = 1000;
export const MAX_CHECKS = 100;
/** Options chosen in one list. */
const MAX_OPTIONS = 1000;

const KINDS: readonly RecordedStep['kind'][] = ['click', 'fill', 'press', 'goto', 'note', 'url', 'hover', 'drag', 'upload', 'missed'];
const DIALOGS: readonly StepDialog['type'][] = ['alert', 'confirm', 'prompt'];
/** Dialogs one step opens, one after the other. */
const MAX_DIALOGS = 20;
const FIELDS: readonly NonNullable<Expectation['field']>[] = ['value', 'select', 'checked', 'name', 'state'];
/** The states a check can say an element is in. */
const STATES = ['visible', 'hidden', 'enabled', 'disabled', 'selected', 'not selected'];
/** Steps that act on an element, and so need one to act on. */
const ON_ELEMENT = new Set<RecordedStep['kind']>(['click', 'fill', 'hover', 'drag', 'upload']);
/** Files chosen at once in one file input. */
const MAX_FILES = 100;
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
  if (ON_ELEMENT.has(kind)) out.locator = locator(o, what, `(${kind}) names no element to ${kind === 'upload' ? 'choose files in' : kind} (locator)`);
  // A key pressed in a field names it; one pressed on the page (an app's shortcut) doesn't.
  if (kind === 'press' && o.locator !== undefined && o.locator !== null) out.locator = locator(o, what, '(press) names no element to press in (locator)');
  if (kind === 'drag') out.to = locator({ locator: o.to }, what, '(drag) names nothing to drop onto (to)');
  if (kind === 'click') {
    if (o.count !== undefined && o.count !== null) {
      if (o.count !== 1 && o.count !== 2) throw refuse(`${what}: count must be 1 or 2 (a double click), not ${shown(o.count)}.`);
      if (o.count === 2) out.count = 2;
    }
    if (o.button !== undefined && o.button !== null) {
      if (o.button !== 'right') throw refuse(`${what}: button can only be “right”, not ${shown(o.button)}.`);
      out.button = 'right';
    }
  }
  if (kind === 'upload') {
    const files = o.files;
    if (!Array.isArray(files) || files.length > MAX_FILES) throw refuse(`${what} (upload) must list the files chosen (files), at most ${MAX_FILES}.`);
    out.files = files.map((f, j) => {
      const r = record(f, `${what}, file ${j + 1}`, 'a file (an object with its name and type)');
      return { name: text(r, 'name', `${what}, file ${j + 1}`, { needed: 'has no name', max: 1000 })!, mimeType: text(r, 'mimeType', `${what}, file ${j + 1}`, { max: 200 }) || 'application/octet-stream' };
    });
  }
  const url = text(o, 'url', what, { max: URL_MAX, ...(kind === 'goto' || kind === 'url' ? { needed: `(${kind}) names no address (url)` } : {}) });
  if (url !== undefined) out.url = url;
  const key = text(o, 'key', what, { max: 100 });
  if (key !== undefined) out.key = key;
  const dialogs = o.dialogs;
  if (dialogs !== undefined && dialogs !== null) {
    if (!Array.isArray(dialogs) || dialogs.length > MAX_DIALOGS) throw refuse(`${what}: dialogs must be a list of at most ${MAX_DIALOGS} dialogs it opens.`);
    out.dialogs = dialogs.map((d, j) => {
      const which = `${what}, dialog ${j + 1}`;
      const r = record(d, which, 'a dialog (an object with its type and whether it was accepted)');
      if (!DIALOGS.includes(r.type as StepDialog['type'])) throw refuse(`${which} is “${shown(r.type)}”: a dialog is one of ${DIALOGS.join(', ')}.`);
      if (typeof r.accept !== 'boolean') throw refuse(`${which}: accept must be true or false, not ${shown(r.accept)}.`);
      const out: StepDialog = { type: r.type as StepDialog['type'], accept: r.accept };
      const answer = text(r, 'text', which, { max: SHORT });
      if (answer !== undefined) out.text = answer;
      const message = text(r, 'message', which, { max: SHORT });
      if (message !== undefined) out.message = message;
      return out;
    });
  }
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
  if (field !== undefined && !FIELDS.includes(field)) throw refuse(`${what} is about “${shown(o.field)}”, which a check can’t read: it reads the text, or a field’s value, select, checked, name or state.`);
  const out: Expectation = {
    locator: locator(o, what, 'names no element to check (locator)'),
    description: text(o, 'description', what, { needed: 'says nothing about what it checks (description)', max: SHORT })!,
    expected: text(o, 'expected', what, { needed: 'says nothing it should show (expected)' })!,
    actual: text(o, 'actual', what) ?? '',
  };
  if (field) out.field = field;
  if (field === 'checked' && out.expected !== 'checked' && out.expected !== 'not checked') throw refuse(`${what} is about whether it is checked, so it should be “checked” or “not checked”, not “${shown(out.expected)}”.`);
  if (field === 'state' && !STATES.includes(out.expected)) throw refuse(`${what} is about a state, so it should be one of ${STATES.map((x) => `“${x}”`).join(', ')}, not “${shown(out.expected)}”.`);
  if (o.waited !== undefined && o.waited !== null) {
    if (typeof o.waited !== 'number' || !Number.isFinite(o.waited) || o.waited < 0) throw refuse(`${what}: waited must be a number of milliseconds, not ${shown(o.waited)}.`);
    out.waited = Math.round(o.waited);
  }
  for (const flag of ['anyCase', 'not'] as const) {
    const v = o[flag];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') throw refuse(`${what}: ${flag} must be true or false, not ${shown(v)}.`);
    if (v) out[flag] = true;
  }
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
