/**
 * A test the studio writes runs with the app's own Playwright (@playwright/test). An app that doesn't have it yet is
 * told so at once, with what adds it, and nothing is downloaded behind its back; one click then adds it with the
 * package manager the app uses, in the app's folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from '../../server/project';
import { addPlaywright, addPlaywrightCommand, hasPlaywright, runSpec } from '../../server/tests/run';
import { tree } from './helpers';

const SPEC = "import { test } from '@playwright/test';\ntest('opens', async () => {});\n";

let saved: string | undefined;
/** Stand-ins for package managers: each says what it was asked and where, and `ends` with that code. */
function standIns(names: string[], ends = 0): void {
  saved ??= process.env.PATH;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-pm-'));
  for (const name of names) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\necho ${name} %*\r\necho in %CD%\r\nexit /b ${ends}\r\n`);
    else fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*"\necho "in $(pwd)"\nexit ${ends}\n`, { mode: 0o755 });
  }
  process.env.PATH = bin;
}
afterEach(() => {
  if (saved !== undefined) process.env.PATH = saved;
  saved = undefined;
});

const app = (files: Record<string, string | object> = {}) => tree({ 'package.json': { name: 'bare', type: 'module' }, 'tests/saywright/opens.spec.ts': SPEC, ...files });
const project = (dir: string) => new Project(dir, 'http://localhost:5999', undefined, true);

describe('an app without Playwright', () => {
  it('is told at once what the test needs and what adds it, and nothing is run', async () => {
    const dir = app({ 'pnpm-lock.yaml': '' });
    // Were anything run (npx, to fetch a Playwright of its own), it would be this stand-in, and the run would say so.
    standIns(['npx', 'pnpm']);
    const started = Date.now();
    const r = await runSpec(project(dir), 'tests/saywright/opens.spec.ts', { baseUrl: 'http://localhost:5999', workDir: path.join(dir, '.runs') });
    expect(r).toMatchObject({ status: 'setup-needed', needs: 'playwright' });
    expect(r.message).toContain('pnpm add -D @playwright/test');
    expect(r.message).not.toMatch(/npx/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hasPlaywright(project(dir))).toBe(false);
  });

  it('is added with the package manager the app uses, as a development dependency', () => {
    expect(addPlaywrightCommand(app()).says).toBe('npm install --save-dev @playwright/test');
    expect(addPlaywrightCommand(app({ 'pnpm-lock.yaml': '' })).says).toBe('pnpm add -D @playwright/test');
    expect(addPlaywrightCommand(app({ 'yarn.lock': '' })).says).toBe('yarn add -D @playwright/test');
    expect(addPlaywrightCommand(app({ 'bun.lock': '' })).says).toBe('bun add -d @playwright/test');
  });

  it('a folder with no package.json is told that adding it makes one', async () => {
    const dir = tree({ 'index.html': '<h1>Hi</h1>', 'tests/saywright/opens.spec.ts': SPEC });
    const r = await runSpec(project(dir), 'tests/saywright/opens.spec.ts', { baseUrl: 'http://localhost:5999', workDir: path.join(dir, '.runs') });
    expect(r).toMatchObject({ status: 'setup-needed', needs: 'playwright' });
    expect(r.message).toMatch(/package\.json/);
  });
});

describe('adding Playwright to the app', () => {
  it('runs that command in the app’s folder, says each line, and is done only when the app has it', async () => {
    const dir = app({ 'yarn.lock': '' });
    standIns(['yarn']);
    const lines: string[] = [];
    // The stand-in installs nothing: the command ran, and the app still has no Playwright.
    expect(await addPlaywright(project(dir), (l) => lines.push(l))).toBe(false);
    expect(lines[0]).toBe('$ yarn add -D @playwright/test');
    expect(lines).toContain('yarn add -D @playwright/test');
    expect(lines.join('\n')).toContain(`in ${fs.realpathSync(dir)}`);
    expect(lines.at(-1)).toMatch(/still/);
    // Once it is there (as the real command leaves it), the same call says yes.
    fs.mkdirSync(path.join(dir, 'node_modules/@playwright/test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/@playwright/test/package.json'), '{"name":"@playwright/test","version":"1.0.0"}');
    expect(await addPlaywright(project(dir), () => {})).toBe(true);
    expect(hasPlaywright(project(dir))).toBe(true);
  });

  it('says why when the command fails', async () => {
    const dir = app();
    standIns(['npm'], 1);
    const lines: string[] = [];
    expect(await addPlaywright(project(dir), (l) => lines.push(l))).toBe(false);
    expect(lines).toContain('npm install --save-dev @playwright/test');
    expect(lines.at(-1)).toMatch(/npm install --save-dev @playwright\/test/);
  });

  it('runs nothing when the app’s package manager isn’t on this computer, and says what to install', async () => {
    const dir = app({ 'pnpm-lock.yaml': '' });
    standIns(['npm']);
    const lines: string[] = [];
    expect(await addPlaywright(project(dir), (l) => lines.push(l))).toBe(false);
    expect(lines.join(' ')).toMatch(/pnpm.*isn’t installed on this computer/);
    expect(lines.join(' ')).toContain('pnpm add -D @playwright/test');
    expect(lines.join(' ')).not.toMatch(/^npm install/m);
  });
});
