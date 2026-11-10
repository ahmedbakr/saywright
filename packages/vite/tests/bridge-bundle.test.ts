/**
 * The bridge runs inside the person's app. Served as a classic script (the studio's /saywright.js, which its proxy
 * injects and the script tag loads), every top-level name of the file would be a global of the app's page: an app
 * whose own script declares `const now` or `function step` would stop with "Identifier 'now' has already been
 * declared". The built file is one wrapped function, so it keeps its names to itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script of the repository, without types.
import { ensurePlugin } from '../../../scripts/lib/plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('the built bridge', () => {
  let code = '';
  beforeAll(() => {
    expect(ensurePlugin()).toBe(true);
    code = fs.readFileSync(path.join(here, '../dist/bridge.js'), 'utf8');
  }, 120_000);

  it('declares nothing at the top level of the page', () => {
    const program = parse(code, { sourceType: 'script' }).program;
    const declared = program.body.filter((s) => s.type !== 'ExpressionStatement' && s.type !== 'EmptyStatement').map((s) => s.type);
    expect(declared).toEqual([]);
    // Nor as a plain assignment to a name it never declared (which would make a global in a classic script).
    expect(program.body.length).toBeLessThanOrEqual(2);
  });

  it('runs as a classic script, as the studio serves it', () => {
    // No `import` or `export` left, which a classic script can't run.
    expect(() => parse(code, { sourceType: 'script' })).not.toThrow();
    // Strict, as the module it is written as.
    expect(code).toMatch(/^\(function\(\) \{\s*["']use strict["'];/);
  });
});
