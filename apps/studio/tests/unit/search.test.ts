/**
 * Code search over a whole project, however big: the files git knows (or a walk that honours .gitignore), every one
 * of them, and an honest note when a search couldn't cover them all, for the AI and for AI apps over MCP.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverageNote, listFilesTool, searchTool } from '../../server/ai/tools';
import { Project } from '../../server/project';

function app(files: Record<string, string>, git = false): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-search-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  if (git) {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('add', 'src/tracked.ts', '.gitignore');
  }
  return new Project(dir, 'http://localhost:1');
}

const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/components/g${Math.floor(i / 100)}/Comp${i}.tsx`, `export const Comp${i} = () => <p>Unique label ${i}</p>;\n`]));

describe('code search', () => {
  it('looks through every file, not just the first few thousand', async () => {
    const p = app(many(2500));
    const r = await p.search('Unique label 2499');
    expect(r.hits).toEqual([{ path: 'src/components/g24/Comp2499.tsx', line: 1, text: 'export const Comp2499 = () => <p>Unique label 2499</p>;' }]);
    expect(r).toMatchObject({ searched: 2500, total: 2500, timedOut: false });
  });

  const files = {
    '.gitignore': 'generated/\n*.log.ts\n',
    'src/tracked.ts': 'const marker = 1;\n',
    'src/untracked.ts': '\n\nconst marker = 2;\n',
    'generated/bundle.ts': 'const marker = 3;\n',
    'src/debug.log.ts': 'const marker = 4;\n',
  };

  it('in a repository: what git tracks, and new files it doesn’t ignore', async () => {
    const r = await app(files, true).search('marker');
    expect(r.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['src/tracked.ts:1', 'src/untracked.ts:3']);
  });

  it('elsewhere: the folder, minus what its .gitignore leaves out', async () => {
    const r = await app(files).search('marker');
    expect(r.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['src/tracked.ts:1', 'src/untracked.ts:3']);
  });

  it('keeps line-by-line regular expressions, ^ and $ included', async () => {
    const p = app({ 'src/a.ts': 'import x from "x";\nconst y = 1; // import\nimport z from "z";\n', 'src/b.ts': '\nconst a = 1;\n\nconst b = 2;' });
    const r = await p.search('^import', { regex: true });
    expect(r.hits.map((h) => h.line)).toEqual([1, 3]);
    // Empty lines, the first line of the file among them.
    expect((await p.search('^\\s*$', { regex: true })).hits.filter((h) => h.path === 'src/b.ts').map((h) => h.line)).toEqual([1, 3]);
    await expect(p.search('(', { regex: true })).rejects.toThrow(/Invalid search pattern/);
  });

  it('counts only the files that are there to search', async () => {
    const p = app({ ...files, 'src/gone.ts': 'const marker = 5;\n' }, true);
    execFileSync('git', ['add', 'src/gone.ts'], { cwd: p.root, stdio: 'pipe' });
    fs.rmSync(path.join(p.root, 'src/gone.ts'));
    expect(await p.search('marker')).toMatchObject({ searched: 2, total: 2, tooLarge: 0 });
  });

  it('sees what the studio just wrote', async () => {
    const p = app({ 'src/a.ts': 'export const a = 1;\n' });
    expect((await p.search('brand new')).hits).toEqual([]);
    p.write('src/a.ts', 'export const a = "brand new";\n');
    expect((await p.search('brand new')).hits).toHaveLength(1);
  });

  it('says how much it covered when it couldn’t look at everything', async () => {
    const p = app({ ...many(300), 'src/huge.ts': `// ${'x'.repeat(3 * 1024 * 1024)}\n` });
    const cut = await p.search('nowhere to be found', { budgetMs: 0 });
    expect(cut.timedOut).toBe(true);
    expect(cut.searched).toBeLessThan(cut.total);
    expect(coverageNote(cut)).toMatch(/^Searched [\d,]+ of 301 files: it ran out of time\. Search a folder \(dir\) to cover the rest\.$/);
    const whole = await p.search('nowhere to be found');
    expect(coverageNote(whole)).toBe('Searched 300 of 301 files: 1 file was too large to search.');
    expect(await searchTool(p, 'nowhere to be found')).toBe('No matches for "nowhere to be found". Searched 300 of 301 files: 1 file was too large to search.');
  });

  it('narrows to a folder, and lists files with how many there are', async () => {
    const p = app(many(450));
    expect(await searchTool(p, 'Unique label 7', false, 'src/components/g0')).toMatch(/^src\/components\/g0\/Comp7.tsx:1: /);
    const list = (await listFilesTool(p)).split('\n');
    expect(list).toHaveLength(401);
    expect(list[400]).toBe('(400 of 450 files; list a folder (dir) to see the others.)');
  });
});
