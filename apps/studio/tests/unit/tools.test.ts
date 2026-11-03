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
