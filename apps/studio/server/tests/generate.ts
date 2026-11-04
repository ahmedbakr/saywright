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
    if (token(STRING) !== null || token(LITERAL) !== null) return true;
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

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'narrated-bug'
  );
}

function testTitle(input: GenerateInput): string {
  if (input.name?.trim()) return input.name.trim();
  const e = input.expectations[0];
  if (!e) return 'narrated flow';
  return `${e.description.replace(/^the /i, '')} should show ${e.expected}`;
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
 * The options a step chose, as selectOption takes them: by what each says ({ label: 'Express' }), or by its value
 * when what it says has numbers in it (a price changes, its value doesn't) or isn't known.
 */
function optionsCode(step: RecordedStep): string {
  const labels = step.select ?? [];
  const values = step.values ?? [];
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

/** A check, as code: text for most things, the value for a field, the option chosen for a list. */
function checkCode(e: Expectation): string {
  const loc = safeLocator(e.locator);
  if (e.field === 'value') return `await expect(${loc}).toHaveValue(new RegExp(${q(escapeRe(e.expected))}));`;
  if (e.field === 'select') return `await expect(${loc}.locator('option:checked')).toContainText(${q(e.expected)});`;
  return `await expect(${loc}).toContainText(${q(e.expected)});`;
}

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
  step(String(++n), `Open ${start}`, [`await page.goto(${q(start)});`]);
  // Each check after the steps that came before it was said (an older studio's, after them all).
  const checksAt = new Map<number, Expectation[]>();
  for (const e of input.expectations) {
    const at = Math.max(0, Math.min(input.steps.length, e.after ?? input.steps.length));
    checksAt.set(at, [...(checksAt.get(at) ?? []), e]);
  }
  // What the page showed goes into the file only masked: a key or a card number on screen is no part of a test.
  const check = (e: Expectation) => {
    step(`check ${++k}`, maskSecrets(`${e.description.replace(/^./, (c) => c.toUpperCase())} should show ${e.expected}`), [
      `// ${jsComment(maskSecrets(`You said ${e.description} should show ${e.expected} (it showed ${e.actual || 'nothing'}).`))}`,
      checkCode(e),
    ]);
  };
  input.steps.forEach((s, i) => {
    for (const e of checksAt.get(i) ?? []) check(e);
    if (s.kind === 'note') {
      lines.push(`  // ${jsComment(maskSecrets(s.description))}`);
      return;
    }
    const code = stepCode(s);
    if (code) step(String(++n), maskSecrets(s.description), [code]);
  });
  for (const e of checksAt.get(input.steps.length) ?? []) check(e);
  lines.push('});', '');
  return lines.join('\n');
}

/** The secrets a test types (by name), as its code reads them. */
export function secretsOf(code: string): string[] {
  return [...new Set(Array.from(code.matchAll(/\bsecret\('([A-Z0-9_]+)'\)/g), (m) => m[1]))];
}

export function writeSpec(project: Project, input: GenerateInput): { path: string; code: string } {
  const code = generateSpec(input);
  const dir = `tests/${BRAND.slug}`;
  const base = slug(testTitle(input));
  let rel = `${dir}/${base}.spec.ts`;
  for (let i = 2; project.exists(rel); i++) rel = `${dir}/${base}-${i}.spec.ts`;
  fs.mkdirSync(path.dirname(project.resolve(rel)), { recursive: true });
  project.write(rel, code);
  return { path: rel, code };
}
