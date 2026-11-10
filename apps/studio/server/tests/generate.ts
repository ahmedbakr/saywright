/**
 * Writes a Playwright test from a recorded flow: its steps and the checks the tester said, in the order they
 * happened. Page text only ever goes into strings and comments, escaped. Each step and each check is a test.step
 * numbered in the order it was written, so a run shows how far the test got, and which of them ran: a pass is only
 * believed when every one of them did. A secret is never written into the file: the test reads it from the
 * environment (SAYWRIGHT_SECRET_PASSWORD), where the studio puts what you saved for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { jsComment, jsString as q, maskSecrets, secretEnvName, SECRET_ENV_PREFIX } from '@saywright/vite/protocol';
import type { Expectation, RecordedStep } from '../../shared/api.ts';
export { sanitizeSteps } from '../../shared/steps.ts';
import { BRAND } from '../../shared/brand.ts';
import { showsValue, wholeValue } from '../../shared/expected.ts';
import { shouldBe } from '../../shared/text.ts';
import type { Project } from '../project.ts';

interface GenerateInput {
  name?: string;
  startUrl: string;
  steps: RecordedStep[];
  expectations: Expectation[];
}

/** What a locator may call, as the bridge writes them: finding, narrowing to a card or row, picking one. */
const CALLS = new Set(['getByRole', 'getByText', 'getByTestId', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'locator', 'filter', 'nth', 'first', 'last']);
/** A string as jsString writes it: single-quoted, every quote and line break escaped. */
const STRING = /^'(?:[^'\\\r\n\u2028\u2029]|\\[^\r\n\u2028\u2029])*'/;
const LITERAL = /^(?:-?\d+(?:\.\d+)?|true|false)/;
/**
 * A regular expression literal as the bridge writes one, for a name or a text with its numbers left open
 * (`/^Pay \$\d[\d.,]* and subscribe$/`): one token as JavaScript reads it, so nothing in it runs either.
 */
const REGEX = /^\/(?![*/])(?:[^/\\[\r\n\u2028\u2029]|\\[^\r\n\u2028\u2029]|\[(?:[^\]\\\r\n\u2028\u2029]|\\[^\r\n\u2028\u2029])*\])+\/[imsu]*/;

/**
 * Locators arrive as Playwright expressions built by the bridge, on one line; accept only that shape: `page`, then
 * calls whose arguments are strings, numbers and flat objects of them. Page text can only be inside those strings,
 * so whatever it says, nothing in it runs.
 */
export function safeLocator(code: string | undefined): string {
  if (!code || !isLocator(code)) throw new Error(`Unexpected locator: ${code}`);
  return code;
}

function isLocator(code: string): boolean {
  let i = 0;
  const blank = () => {
    while (code[i] === ' ') i++;
  };
  const token = (re: RegExp): string | null => {
    const m = re.exec(code.slice(i));
    if (m) i += m[0].length;
    return m?.[0] ?? null;
  };
  const value = (flat: boolean): boolean => {
    blank();
    if (token(STRING) !== null || token(LITERAL) !== null || token(REGEX) !== null) return true;
    if (flat || code[i] !== '{') return false;
    i++;
    for (;;) {
      blank();
      if (code[i] === '}') {
        i++;
        return true;
      }
      if (!token(/^[A-Za-z_$][\w$]*/)) return false;
      blank();
      if (code[i++] !== ':' || !value(true)) return false;
      blank();
      if (code[i] === ',') i++;
      else if (code[i] !== '}') return false;
    }
  };
  if (!token(/^page(?=\.(?:getBy[A-Za-z]+|locator)\()/)) return false;
  while (i < code.length) {
    if (code[i++] !== '.') return false;
    const name = token(/^[A-Za-z]+/);
    if (!name || !CALLS.has(name) || code[i++] !== '(') return false;
    blank();
    while (code[i] !== ')') {
      if (!value(false)) return false;
      blank();
      if (code[i] === ',') i++;
      else if (code[i] !== ')') return false;
      blank();
    }
    i++;
  }
  return true;
}

/** A file name from a test's title: at most 48 characters, ending at a word's end (“…-should-show-80-80”, not “…-sho”). */
export function slug(s: string): string {
  const all = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (all.length <= 48) return all || 'narrated-bug';
  const end = all.slice(0, 49).lastIndexOf('-');
  return end >= 16 ? all.slice(0, end) : all.slice(0, 48);
}

function testTitle(input: GenerateInput): string {
  if (input.name?.trim()) return input.name.trim();
  const e = input.expectations[0];
  if (!e) return 'narrated flow';
  return `${e.description.replace(/^the /i, '')} ${shouldBe({ ...e, expected: brief(e.expected) }, plain)}`;
}

const plain = (s: string) => s;
/** A value in words: at most 200 characters of it. */
const brief = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/** What a test's first step says when the app sent it elsewhere as it opened. */
export const STARTS_ELSEWHERE = 'The test didn’t get to the page it starts on';

/**
 * A check that held on screen as it was said is marked so in its code: if it fails in a run, the test doesn't replay
 * what was done (a step that wasn't recorded, a page that starts differently), and that isn't the bug.
 */
export const HELD = '// It showed that when you said it: if this fails, the test doesn’t replay what you did.';

/** Whether the screen showed what a check says, as it was said. Unknown (a state not read then) is no. */
export function heldWhenSaid(e: Expectation): boolean {
  if (e.field === 'checked') return e.actual === e.expected;
  if (e.field === 'state') return e.expected === 'visible' && e.actual === 'visible';
  if (!e.actual) return !!e.not;
  if (e.field === 'select') {
    const chosen = e.actual.split(', ').some((c) => showsValue(c, e.expected) && showsValue(e.expected, c));
    return e.not ? !chosen : chosen;
  }
  const shows = showsValue(e.actual, e.expected);
  return e.not ? !shows : shows;
}

/** A secret's name as the test reads it: capitals, digits and underscores (PASSWORD, CARD_NUMBER). */
const secretKey = (name: string) => secretEnvName(name).slice(SECRET_ENV_PREFIX.length);

/** A page's address without its origin, as `page.goto` takes it with the config's baseURL. */
function pathOf(url: string): string {
  try {
    const u = new URL(url, 'http://app.invalid');
    return `${u.pathname}${u.search}${u.hash}` || '/';
  } catch {
    return '/';
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * What a page's address must look like to be the same page on another run: its path, with the parts that change
 * from one run to the next (numbers, ids) left open; the query and the hash are left out. A hash route (#/checkout)
 * is the path.
 */
export function urlPattern(url: string): string {
  let u: URL;
  try {
    u = new URL(url, 'http://app.invalid');
  } catch {
    return '.*';
  }
  const route = u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0] : u.pathname;
  const parts = route.split('/').map((p) => {
    if (!p) return '';
    const plain = decodeURIComponentSafe(p);
    return /\d/.test(plain) && (/^\d+$/.test(plain) || /^[0-9a-f-]{8,}$/i.test(plain) || /^[\w-]{16,}$/.test(plain)) ? '[^/?#]+' : escapeRe(p);
  });
  // A trailing slash or not is the same page.
  const body = parts.join('/').replace(/\/$/, '') || '';
  return u.hash.startsWith('#/') ? `^[^#]*#${body}/?(?:[?]|$)` : `^[a-z]+://[^/]+${body}/?(?:[?#]|$)`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** How a step is done, as code. */
function stepCode(step: RecordedStep): string | null {
  switch (step.kind) {
    case 'click':
      return `await ${safeLocator(step.locator)}.click();`;
    case 'fill': {
      const loc = safeLocator(step.locator);
      if (step.secret) return `await ${loc}.fill(secret(${q(secretKey(step.secret))}));`;
      if (step.checked !== undefined) return `await ${loc}.${step.checked ? 'check' : 'uncheck'}();`;
      if (step.select || step.values) return `await ${loc}.selectOption(${optionsCode(step)});`;
      return `await ${loc}.fill(${q(maskSecrets(step.value ?? ''))});`;
    }
    case 'press':
      return `await ${safeLocator(step.locator)}.press(${q(step.key ?? 'Enter')});`;
    case 'goto':
      return step.url ? `await page.goto(${q(pathOf(step.url))});` : null;
    case 'url':
      return step.url ? `await expect(page).toHaveURL(new RegExp(${q(urlPattern(step.url))}));` : null;
    default:
      return null;
  }
}

/**
 * The browser's dialogs a step opens, answered as the person did, set up before the step: Playwright cancels a dialog
 * nobody answers, and the app would then take the other branch. Each answer waits for its own dialog, in order.
 */
function dialogsCode(dialogs: NonNullable<RecordedStep['dialogs']>): string[] {
  const answer = (d: (typeof dialogs)[number]) => (d.accept ? `dialog.accept(${d.type === 'prompt' ? q(maskSecrets(d.text ?? '')) : ''})` : 'dialog.dismiss()');
  const said = (d: (typeof dialogs)[number]) => {
    const what = d.message ? `“${maskSecrets(d.message)}”` : `a${d.type === 'alert' ? 'n alert' : ` ${d.type}`}`;
    const how = !d.accept ? 'Cancel' : d.type === 'prompt' ? `“${maskSecrets(d.text ?? '')}” and OK` : 'OK';
    return `${what}: ${how}`;
  };
  const once = (i: number): string => {
    const d = dialogs[i];
    return i === dialogs.length - 1 ? `page.once('dialog', (dialog) => ${answer(d)});` : `page.once('dialog', (dialog) => { ${once(i + 1)} return ${answer(d)}; });`;
  };
  return [`// It opens ${dialogs.map((d) => jsComment(said(d))).join(', then ')}, answered as you did.`, once(0)];
}

/**
 * The options a step chose, as selectOption takes them: by what each says ({ label: 'Express' }), or by its value
 * when what it says has numbers in it (a price changes, its value doesn't) or isn't known; by value alone when another
 * option of the list says the same as one chosen ({ value: 'std-us' }).
 */
function optionsCode(step: RecordedStep): string {
  const labels = step.select ?? [];
  const values = step.values ?? [];
  if (step.byValue && values.length) return values.length === 1 ? `{ value: ${q(values[0])} }` : `[${values.map((v) => `{ value: ${q(v)} }`).join(', ')}]`;
  const one = (i: number) => {
    const label = labels[i] ?? '';
    const value = values[i];
    if (label && !/\d/.test(label)) return `{ label: ${q(label)} }`;
    // By value, which selectOption also matches against what an option says when no value fits.
    if (value !== undefined && value !== '') return q(value);
    return `{ label: ${q(label)} }`;
  };
  const count = Math.max(labels.length, values.length);
  if (count <= 1) return count ? one(0) : '[]';
  return `[${Array.from({ length: count }, (_, i) => one(i)).join(', ')}]`;
}

/**
 * How long a field's expected value may be and still be checked as a pattern (which says where the field was and what
 * it held when it fails). A longer one is checked as text: a pattern that long is more than a browser will compile.
 */
const PATTERN_MAX = 1000;

/**
 * A check, as code: text for most things, the value for a field (holding what was said), whether a checkbox is
 * checked, the options chosen in a list (one of them says it, however many are chosen). What was said is checked as a
 * whole value, never inside a longer word or number: as text (toHaveText) when the element shows that value and
 * nothing else, else as a pattern, with a line that says what it means. Lines, not one: a pattern's meaning comes first.
 */
function checkCode(e: Expectation): string[] {
  const loc = safeLocator(e.locator);
  const time = waitFor(e);
  const lines = checkLines(e, loc, time ? `timeout: ${time}` : '');
  return time ? [`// You waited ${Math.round(e.waited! / 1000)} s before saying it: it waits up to ${time / 1000} s.`, ...lines] : lines;
}

/** How long a check waits (ms) when that is longer than the run's 10 s: as long as the tester waited, and a half, at most 30 s. */
function waitFor(e: Expectation): number | null {
  if (!e.waited || e.waited < 8000) return null;
  return Math.min(30_000, Math.max(10_000, Math.ceil((e.waited * 1.5) / 1000) * 1000));
}

/** A matcher's options, with the check's own timeout among them (`timeout: 15000`); `last`: they end its arguments. */
const opts = (wait: string, ...more: string[]) => {
  const all = [...more, wait].filter(Boolean);
  return all.length ? `{ ${all.join(', ')} }` : '';
};
const after = (o: string) => (o ? `, ${o}` : '');

function checkLines(e: Expectation, loc: string, wait: string): string[] {
  if (e.field === 'checked') return [`await expect(${loc}).${e.expected === 'not checked' ? 'not.' : ''}toBeChecked(${opts(wait)});`];
  if (e.field === 'state') {
    const matcher = Object.hasOwn(STATE_MATCHERS, e.expected) ? STATE_MATCHERS[e.expected] : undefined;
    if (!matcher) throw new Error(`Unexpected state: ${e.expected}`);
    return [`await expect(${loc}).${matcher.replace(/\((.*)\)$/, (_, a: string) => `(${[a, opts(wait)].filter(Boolean).join(', ')})`)};`];
  }
  const whole = wholeValue(e.expected);
  const not = e.not ? 'not.' : '';
  // Words not seen on the page as said are compared without case: speech doesn't know a capital.
  const flags = `${e.anyCase ? 'i' : ''}${whole.amount ? '' : 'u'}`;
  const pattern = `/${whole.source}/${flags}`;
  const anyCase = after(opts(wait, e.anyCase ? 'ignoreCase: true' : ''));
  const w = after(opts(wait));
  const note = `// ${jsComment(maskSecrets(`${whole.why}.`))}`;
  // An option says the value and nothing else.
  if (e.field === 'select') return [`await expect(${loc}.locator('option:checked')).${not}toContainText([/${whole.only}/${flags}]${w});`];
  if (e.field === 'value') {
    if (e.expected.length > PATTERN_MAX) return [`await expect.poll(() => ${loc}.inputValue()${w}).${not}toContain(${q(e.expected)});`];
    if (onlyThat(e)) return [e.anyCase ? `await expect(${loc}).toHaveValue(/${whole.only}/${flags}${w});` : `await expect(${loc}).toHaveValue(${q(e.expected)}${w});`];
    return [note, `await expect(${loc}).${not}toHaveValue(${pattern}${w});`];
  }
  // An image by its accessible name: its alt text.
  if (e.field === 'name') {
    if (onlyThat(e)) return [`await expect(${loc}).toHaveAccessibleName(${q(e.expected)}${anyCase});`];
    return [note, `await expect(${loc}).${not}toHaveAccessibleName(${pattern}${w});`];
  }
  if (e.expected.length > PATTERN_MAX) return [`await expect(${loc}).${not}toContainText(${q(e.expected)}${anyCase});`];
  if (onlyThat(e)) return [`await expect(${loc}).toHaveText(${q(e.expected)}${anyCase});`];
  return [note, `await expect(${loc}).${not}toContainText(${pattern}${w});`];
}

/**
 * Whether the element shows a value and nothing else, so the check can say it plainly (toHaveText): it shows exactly
 * what was said, or an amount written the same way ($51.71 where $64.64 should be).
 */
function onlyThat(e: Expectation): boolean {
  // Not showing a value is checked by its pattern: not there as a whole, however the rest reads.
  if (e.not) return false;
  const said = collapse(e.expected);
  const shown = collapse(e.actual);
  if (!said || !shown) return false;
  if (shown === said) return true;
  const shape = (s: string) => s.replace(/\d+/g, '0');
  return wholeValue(said).amount && /\d/.test(shown) && shape(shown) === shape(said);
}

/** A state, as Playwright's own matcher checks it. Selected is aria-selected (a tab, an option of a listbox). */
const STATE_MATCHERS: Record<string, string> = {
  visible: 'toBeVisible()',
  hidden: 'toBeHidden()',
  enabled: 'toBeEnabled()',
  disabled: 'toBeDisabled()',
  selected: "toHaveAttribute('aria-selected', 'true')",
  'not selected': "not.toHaveAttribute('aria-selected', 'true')",
};

const collapse = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** A step title: its number (what a run is checked against) and its words, on one line. */
const title = (mark: string, words: string) => q(`[${mark}] ${words.replace(/\s+/g, ' ').trim().slice(0, 160)}`);

export function generateSpec(input: GenerateInput, date = new Date()): string {
  const start = pathOf(input.startUrl);
  const secrets = [...new Set(input.steps.filter((s) => s.kind === 'fill' && s.secret).map((s) => secretKey(s.secret!)))];
  const lines: string[] = [];
  lines.push(`import { expect, test } from '@playwright/test';`, '');
  lines.push(`// Narrated with ${BRAND.name} on ${date.toISOString().slice(0, 10)}: the steps you took and the checks you said, in that order.`);
  lines.push(`// Each is a test.step, so a run shows how far it got. It starts from a fresh browser, with no cookies or storage.`);
  if (secrets.length) {
    lines.push(`// Secrets are never written here: it types ${secrets.join(', ')} from ${secrets.map((s) => secretEnvName(s)).join(', ')}`);
    lines.push(`// (${BRAND.name} sets the ones you saved in its Test tab; elsewhere, set them in the environment).`);
    lines.push(`function secret(name: string): string {`);
    lines.push(`  const value = process.env[\`${SECRET_ENV_PREFIX}\${name}\`];`);
    lines.push(`  if (!value) throw new Error(\`This test needs ${SECRET_ENV_PREFIX}\${name}: set it in the environment, or save it in ${BRAND.name}'s Test tab.\`);`);
    lines.push(`  return value;`);
    lines.push(`}`);
  }
  lines.push('');
  lines.push(`test(${q(testTitle(input))}, async ({ page }) => {`);
  let n = 0;
  let k = 0;
  const step = (mark: string, words: string, body: string[]) => {
    lines.push(`  await test.step(${title(mark, words)}, async () => {`);
    for (const b of body) lines.push(`    ${b}`);
    lines.push(`  });`);
  };
  // A test that is sent elsewhere as it opens (to a sign-in page) fails here, at its first step: not at a check.
  step(String(++n), `Open ${start}`, [`await page.goto(${q(start)});`, `await expect(page, ${q(STARTS_ELSEWHERE)}).toHaveURL(new RegExp(${q(urlPattern(input.startUrl))}));`]);
  // Each check after the steps that came before it was said (an older studio's, after them all).
  const checksAt = new Map<number, Expectation[]>();
  for (const e of input.expectations) {
    const at = Math.max(0, Math.min(input.steps.length, e.after ?? input.steps.length));
    checksAt.set(at, [...(checksAt.get(at) ?? []), e]);
  }
  // What the page showed goes into the file only masked: a key or a card number on screen is no part of a test.
  const check = (e: Expectation) => {
    // In words, a long value is cut short; the check itself holds all of it.
    const said = { ...e, expected: brief(e.expected) };
    const was = e.field === 'checked' ? `it was ${e.actual || 'not checked'}` : e.field === 'state' ? (e.actual ? `it was ${e.actual}` : '') : `it showed ${brief(e.actual) || 'nothing'}`;
    step(`check ${++k}`, maskSecrets(`${e.description.replace(/^./, (c) => c.toUpperCase())} ${shouldBe(said, plain)}`), [
      `// ${jsComment(maskSecrets(`You said ${e.description} ${shouldBe(said, plain)}${was ? ` (${was})` : ''}.`))}`,
      ...(heldWhenSaid(e) ? [HELD] : []),
      ...checkCode(e),
    ]);
  };
  input.steps.forEach((s, i) => {
    for (const e of checksAt.get(i) ?? []) check(e);
    if (s.kind === 'note') {
      lines.push(`  // ${jsComment(maskSecrets(s.description))}`);
      return;
    }
    const code = stepCode(s);
    if (code) step(String(++n), maskSecrets(s.description), [...(s.dialogs?.length ? dialogsCode(s.dialogs) : []), code]);
  });
  for (const e of checksAt.get(input.steps.length) ?? []) check(e);
  lines.push('});', '');
  return lines.join('\n');
}

/** The secrets a test types (by name), as its code reads them. */
export function secretsOf(code: string): string[] {
  return [...new Set(Array.from(code.matchAll(/\bsecret\('([A-Z0-9_]+)'\)/g), (m) => m[1]))];
}

/**
 * Write the test to `tests/saywright/`, never over a file of someone else's. `replace`: the test this one is a new
 * version of (written again after another check was added): it takes that file's place when the studio wrote it and
 * nobody changed it since, rather than leaving both to run.
 */
export function writeSpec(project: Project, input: GenerateInput, replace?: { path: string; code: string }): { path: string; code: string } {
  const code = generateSpec(input);
  const dir = `tests/${BRAND.slug}`;
  if (replace && replace.path.startsWith(`${dir}/`) && /^[\w./-]+\.spec\.ts$/.test(replace.path) && !replace.path.includes('..') && project.exists(replace.path) && project.read(replace.path) === replace.code) {
    project.write(replace.path, code);
    return { path: replace.path, code };
  }
  const base = slug(testTitle(input));
  let rel = `${dir}/${base}.spec.ts`;
  for (let i = 2; project.exists(rel); i++) rel = `${dir}/${base}-${i}.spec.ts`;
  fs.mkdirSync(path.dirname(project.resolve(rel)), { recursive: true });
  project.write(rel, code);
  return { path: rel, code };
}
