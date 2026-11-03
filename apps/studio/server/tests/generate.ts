/**
 * Writes a Playwright test from a recorded flow: its steps, and what the tester
 * said should show. Page text only ever goes into strings and comments, escaped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { jsComment, jsString as q } from '@saywright/vite/protocol';
import type { Expectation, RecordedStep } from '../../shared/api.ts';
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

export function generateSpec(input: GenerateInput, date = new Date()): string {
  const url = new URL(input.startUrl);
  const start = `${url.pathname}${url.search}${url.hash}` || '/';
  const lines: string[] = [];
  lines.push(`import { expect, test } from '@playwright/test';`, '');
  lines.push(`// Narrated with ${BRAND.name} on ${date.toISOString().slice(0, 10)}. Expectations come from what was said.`);
  lines.push(`test(${q(testTitle(input))}, async ({ page }) => {`);
  lines.push(`  await page.goto(${q(start)});`);
  for (const step of input.steps) {
    switch (step.kind) {
      case 'click':
        lines.push(`  await ${safeLocator(step.locator)}.click();`);
        break;
      case 'fill':
        if (step.checked !== undefined) lines.push(`  await ${safeLocator(step.locator)}.${step.checked ? 'check' : 'uncheck'}();`);
        else lines.push(`  await ${safeLocator(step.locator)}.fill(${q(step.value ?? '')});`);
        break;
      case 'press':
        lines.push(`  await ${safeLocator(step.locator)}.press(${q(step.key ?? 'Enter')});`);
        break;
      case 'goto':
        if (step.url) {
          const u = new URL(step.url);
          lines.push(`  await page.goto(${q(`${u.pathname}${u.search}${u.hash}`)});`);
        }
        break;
      case 'note':
        lines.push(`  // ${jsComment(step.description)}`);
        break;
    }
  }
  for (const e of input.expectations) {
    lines.push(`  // ${jsComment(`You said ${e.description} should show ${e.expected} (it showed ${e.actual || 'nothing'}).`)}`);
    lines.push(`  await expect(${safeLocator(e.locator)}).toContainText(${q(e.expected)});`);
  }
  lines.push('});', '');
  return lines.join('\n');
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
