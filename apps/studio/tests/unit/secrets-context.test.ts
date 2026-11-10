/**
 * What the AI may read and how much is sent: files that hold keys are off limits whatever their case, keys written
 * in code go out as placeholders and come back in edits, the first message's code is capped, and a search pattern
 * that could freeze the studio is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemPrompt, userMessage } from '../../server/ai/context';
import { applyEditSpecs, readFileTool, searchTool } from '../../server/ai/tools';
import { unsafePattern } from '../../server/project';
import { tempShop } from './helpers';

// Put together here, so that no file of the repository holds anything shaped like a real key.
const KEY = ['sk', 'live', '51ExampleOnlyNotARealKey0000000000'].join('_');
const DB = 'postgres://admin:hunter2-password@db.example.com/shop';

function shop() {
  const project = tempShop();
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(project.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(project.root, rel), text);
  };
  put('src/pay.js', `export const PAYMENTS_SECRET = '${KEY}';\nexport const DB = '${DB}';\nexport const label = 'Pay now';\n`);
  for (const f of ['.dev.vars', '.npmrc', '.netrc', 'config/secrets.json', '.aws/credentials', 'deploy/id_ed25519', 'certs/server.pem', 'app.KEY', 'src/credentials.ts']) put(f, 'TOKEN=abc\n');
  return project;
}

describe('files that hold keys', () => {
  it('are refused to every reader, whatever the case of their name, and left out of the file list', async () => {
    const project = shop();
    for (const f of ['.dev.vars', '.npmrc', '.netrc', 'config/secrets.json', '.aws/credentials', 'deploy/id_ed25519', 'certs/server.pem', 'app.KEY', 'src/credentials.ts', '.ENV', 'Config/Secrets.json']) {
      expect(() => readFileTool(project, f), f).toThrow(/off limits/);
    }
    expect(() => applyEditSpecs(project, [{ path: '.npmrc', old_string: 'TOKEN=abc', new_string: 'x' }])).toThrow(/off limits/);
    expect(systemPrompt(project)).not.toMatch(/secrets\.json|credentials\.ts/);
    expect(await searchTool(project, 'TOKEN')).not.toMatch(/credentials|secrets\.json/);
  });
});

describe('keys written in code', () => {
  it('go out as placeholders in read_file, search and the first message, and an edit that quotes one keeps the key', async () => {
    const project = shop();
    const read = readFileTool(project, 'src/pay.js');
    expect(read).not.toContain(KEY);
    expect(read).not.toContain('hunter2-password');
    expect(read).toMatch(/SAYWRIGHT_SECRET_1/);
    expect(read).toContain('postgres://admin:SAYWRIGHT_SECRET_2@db.example.com');
    expect(await searchTool(project, 'PAYMENTS_SECRET')).not.toContain(KEY);
    const msg = userMessage({ text: 'rename it', refs: [{ role: 'button', name: 'Pay now', src: 'src/pay.js:3:1' } as never], mode: 'edit' }, project);
    expect(msg).not.toContain(KEY);
    // The model copies the line as it was shown.
    const shown = read.split('\n').find((l) => l.includes('PAYMENTS_SECRET'))!.replace(/^\s*\d+\s{2}/, '');
    const edits = applyEditSpecs(project, [{ path: 'src/pay.js', old_string: shown, new_string: shown.replace('PAYMENTS_SECRET', 'STRIPE_SECRET') }]);
    expect(edits[0].after).toContain(`export const STRIPE_SECRET = '${KEY}';`);
  });
});

describe('the code sent with the first message', () => {
  it('leaves out a minified file, cuts very long lines, and sends one window per place in a long file', () => {
    const project = shop();
    fs.writeFileSync(path.join(project.root, 'src/vendor.min.js'), `var a=${'1,'.repeat(600_000)}0;`);
    const long = Array.from({ length: 5000 }, (_, i) => (i === 10 ? `const svg = '${'M0 0 L1 1 '.repeat(2000)}';` : `const line${i} = ${i};`)).join('\n');
    fs.writeFileSync(path.join(project.root, 'src/Table.jsx'), long);
    const msg = userMessage(
      {
        text: 'x',
        refs: [{ role: 'div', name: 'a', src: 'src/vendor.min.js:1:1' } as never, { role: 'td', name: 'b', src: 'src/Table.jsx:20:1' } as never, { role: 'td', name: 'c', src: 'src/Table.jsx:4900:1' } as never],
        mode: 'edit',
      },
      project,
    );
    expect(msg).toMatch(/src\/vendor\.min\.js: not included \(minified or data/);
    expect(msg).toMatch(/line cut: 20,0\d\d characters/);
    expect(msg).toContain('--- src/Table.jsx (lines 1-100 of 5000');
    expect(msg).toContain('--- src/Table.jsx (lines 4820-4980 of 5000');
    expect(msg).not.toContain('const line2500 =');
    expect(msg.length).toBeLessThan(130_000);
  });
});

describe('search patterns', () => {
  it('one that could take exponential time is refused; ordinary ones are not', async () => {
    for (const p of ['(a+)+$', '(a|aa)*b', '(\\w+\\s?)*$', '(.*a){10}', '(x)\\1']) expect(unsafePattern(p), p).toBe(true);
    for (const p of ['discount\\s*=', 'a+b', '(foo|bar)', 'round2\\(', '[(+)]+', '(ab)+c']) expect(unsafePattern(p), p).toBe(false);
    const project = shop();
    fs.writeFileSync(path.join(project.root, 'src/a.js'), `// ${'a'.repeat(40)}!\n`);
    const started = Date.now();
    await expect(project.search('(a+)+$', { regex: true })).rejects.toThrow(/could take too long/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
