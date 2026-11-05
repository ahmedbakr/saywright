/**
 * What a real Playwright run of a test file proves: a check that failed counts though the test caught its error, and
 * every test in the file counts, not only the first. (Plain tests, so no browser starts.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Project } from '../../server/project';
import { runSpec } from '../../server/tests/run';

const ROOT = path.resolve(__dirname, '../../../..');
const HEAD = "import { test, expect } from '@playwright/test';\n";

function project(files: Record<string, string>): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-verdict-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"verdict","type":"module"}');
  // This repository's Playwright, as the app's own.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), HEAD + text);
  return new Project(dir, 'http://localhost:5999', undefined, true);
}

const run = (p: Project, file: string) => runSpec(p, file, { baseUrl: 'http://localhost:5999', workDir: path.join(p.root, '.runs') });

describe('a real run', () => {
  const p = project({
    'caught.spec.ts': "test('caught', async () => {\n  await test.step('[1] start', async () => {});\n  try {\n    await test.step('[check 1] broken', async () => expect(1).toBe(2));\n  } catch {}\n});\n",
    'second.spec.ts': "test('first', async () => {\n  await test.step('[1] start', async () => {});\n  await test.step('[check 1] okay', async () => expect(1).toBe(1));\n});\ntest('second', async () => expect(1).toBe(2));\n",
    'good.spec.ts': "test('good', async () => {\n  await test.step('[1] start', async () => {});\n  await test.step('[check 1] okay', async () => expect(1).toBe(1));\n});\n",
    // A passing test focused, the failing one after it left out of the run.
    'focused.spec.ts': "test.only('first', async () => {\n  await test.step('[1] start', async () => {});\n  await test.step('[check 1] okay', async () => expect(1).toBe(1));\n});\ntest('second', async () => expect(1).toBe(2));\n",
    'focused-marks.spec.ts': "test.only('first', async () => {\n  await test.step('[1] start', async () => {});\n  await test.step('[check 1] okay', async () => expect(1).toBe(1));\n});\ntest('second', async () => {\n  await test.step('[1] start', async () => {});\n  await test.step('[check 1] broken', async () => expect(1).toBe(2));\n});\n",
    // The same marks in two tests: the second test's check never runs.
    'twice.spec.ts': "test('first', async () => {\n  await test.step('[1] start', async () => {});\n  await test.step('[check 1] okay', async () => expect(1).toBe(1));\n});\ntest('second', async () => {\n  await test.step('[1] start', async () => {});\n  if (Date.now() < 0) await test.step('[check 1] never', async () => expect(1).toBe(2));\n});\n",
  });

  it('a check that failed inside a caught block fails the run', async () => {
    const r = await run(p, 'caught.spec.ts');
    expect(r).toMatchObject({ status: 'failed', failedAt: 'check', counts: { checks: 1, checksPassed: 0 } });
    expect(r.verified).toBeFalsy();
  }, 60_000);

  it('a second test that fails fails the file', async () => {
    const r = await run(p, 'second.spec.ts');
    expect(r.status).toBe('failed');
    expect(r.verified).toBeFalsy();
  }, 60_000);

  it('a file whose steps and check all pass is verified', async () => {
    expect(await run(p, 'good.spec.ts')).toMatchObject({ status: 'passed', verified: true, counts: { steps: 1, checks: 1, stepsPassed: 1, checksPassed: 1 } });
  }, 60_000);

  it('a focused test (test.only) is refused, never verified alone: the rest of its file would be left out', async () => {
    for (const file of ['focused.spec.ts', 'focused-marks.spec.ts']) {
      const r = await run(p, file);
      expect(r, file).toMatchObject({ status: 'error', message: expect.stringMatching(/^This test file has test\.only/) });
      expect(r.verified, file).toBeFalsy();
    }
  }, 60_000);

  it('a mark written twice must run twice: a second test whose check never ran doesn’t verify the file', async () => {
    const r = await run(p, 'twice.spec.ts');
    expect(r).toMatchObject({ status: 'passed', verified: false, counts: { steps: 2, checks: 2, stepsPassed: 2, checksPassed: 1 } });
    expect(r.unverified).toMatch(/didn’t report running \(\[check 1\]\)/);
  }, 60_000);
});
