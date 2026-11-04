import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEditSpecs, readFileTool } from '../../server/ai/tools';
import { tempShop } from './helpers';

describe('applyEditSpecs', () => {
  it('applies a unique exact edit', () => {
    const p = tempShop();
    const [e] = applyEditSpecs(p, [{ path: 'src/lib/pricing.ts', old_string: '(subtotal + shipping) * rate', new_string: 'subtotal * rate' }]);
    expect(e.after).toContain('round2(subtotal * rate)');
    expect(e.before).toContain('(subtotal + shipping)');
  });

  it('explains missing and ambiguous matches so the model can retry', () => {
    const p = tempShop();
    expect(() => applyEditSpecs(p, [{ path: 'src/lib/pricing.ts', old_string: 'nope', new_string: 'x' }])).toThrow(/not found/);
    expect(() => applyEditSpecs(p, [{ path: 'src/lib/pricing.ts', old_string: 'rate', new_string: 'x' }])).toThrow(/appears \d+ times/);
  });

  it('refuses paths outside the project and env files', () => {
    const p = tempShop();
    expect(() => applyEditSpecs(p, [{ path: '../evil.ts', old_string: '', new_string: 'x' }])).toThrow(/outside/);
    expect(() => applyEditSpecs(p, [{ path: '.env.local', old_string: '', new_string: 'x' }])).toThrow(/off limits/);
    expect(() => applyEditSpecs(p, [{ path: 'node_modules/x.js', old_string: '', new_string: 'x' }])).toThrow(/not editable/);
  });

  it('never follows a link out of the project, to read, write or search (a repository can carry one)', async () => {
    const p = tempShop();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE');
    fs.symlinkSync(outside, path.join(p.root, 'outlink'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(p.root, 'src', 'secret.ts'));
    fs.symlinkSync(path.join(outside, 'later.txt'), path.join(p.root, 'dangling.ts'));
    expect(() => applyEditSpecs(p, [{ path: 'outlink/PWNED.txt', old_string: '', new_string: 'x' }])).toThrow(/outside/);
    expect(fs.existsSync(path.join(outside, 'PWNED.txt'))).toBe(false);
    expect(() => p.read('outlink/secret.txt')).toThrow(/outside/);
    expect(() => p.read('src/secret.ts')).toThrow(/outside/);
    // A link to a file that doesn't exist yet: writing it would create the file outside.
    expect(() => p.write('dangling.ts', 'x')).toThrow(/outside/);
    expect(fs.existsSync(path.join(outside, 'later.txt'))).toBe(false);
    expect((await p.search('OUTSIDE')).hits).toEqual([]);
    // A link that stays inside is fine.
    fs.symlinkSync(path.join(p.root, 'src', 'lib'), path.join(p.root, 'libs'));
    expect(p.read('libs/pricing.ts')).toContain('calcTotals');
  });

  it('refuses a link inside the project to where its path couldn’t go: an environment file, .git or the studio’s data', () => {
    const p = tempShop();
    fs.writeFileSync(path.join(p.root, '.env'), 'TOKEN=dummy-value\n');
    fs.mkdirSync(path.join(p.root, '.saywright', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(p.root, '.saywright', 'sessions', 'notes.json'), '{}');
    fs.symlinkSync('../.env', path.join(p.root, 'src', 'notes.txt'));
    fs.symlinkSync('../.saywright', path.join(p.root, 'src', 'data'));
    expect(() => p.read('src/notes.txt')).toThrow(/off limits/);
    expect(() => readFileTool(p, 'src/notes.txt')).toThrow(/off limits/);
    expect(() => p.read('src/data/sessions/notes.json')).toThrow(/not editable/);
    expect(() => applyEditSpecs(p, [{ path: 'src/notes.txt', old_string: 'dummy-value', new_string: 'x' }])).toThrow(/off limits/);
    // The link and the file it leads to are as they were.
    expect(fs.lstatSync(path.join(p.root, 'src', 'notes.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(p.root, '.env'), 'utf8')).toBe('TOKEN=dummy-value\n');
  });

  it('writes through a link that stays inside to the file it leads to, and the link stays a link', () => {
    const p = tempShop();
    const real = path.join(p.root, 'src', 'lib', 'money.ts');
    const before = fs.readFileSync(real, 'utf8');
    fs.symlinkSync('lib/money.ts', path.join(p.root, 'src', 'money-link.ts'));
    p.write('src/money-link.ts', `${before}// changed\n`);
    expect(fs.lstatSync(path.join(p.root, 'src', 'money-link.ts')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(`${before}// changed\n`);
    // An undo writes the old text back the same way.
    p.write('src/money-link.ts', before);
    expect(fs.readFileSync(real, 'utf8')).toBe(before);
    expect(fs.lstatSync(path.join(p.root, 'src', 'money-link.ts')).isSymbolicLink()).toBe(true);
  });

  it('creates new files when old_string is empty', () => {
    const p = tempShop();
    const [e] = applyEditSpecs(p, [{ path: 'src/new.ts', old_string: '', new_string: 'export const a = 1;\n' }]);
    expect(e.before).toBeNull();
  });
});

describe('readFileTool', () => {
  it('numbers lines and reports the range', () => {
    const p = tempShop();
    const out = readFileTool(p, 'src/lib/money.ts', 1, 2);
    expect(out).toMatch(/^src\/lib\/money.ts \(lines 1-2 of \d+\)\n   1  export function money/);
  });
});
