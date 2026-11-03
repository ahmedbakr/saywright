import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChangeStore } from '../../server/changes';
import { tempShop } from './helpers';

const edit = (p: ReturnType<typeof tempShop>, find: string, replace: string) => {
  const before = p.read('src/lib/money.ts');
  return { path: 'src/lib/money.ts', before, after: before.replace(find, replace) };
};

describe('ChangeStore', () => {
  it('writes previews to disk, keeps and undoes them', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    const original = p.read('src/lib/money.ts');
    const c = await store.preview({ title: 'one', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    expect(c.status).toBe('preview');
    expect(c.files[0].added).toBeGreaterThan(0);
    expect(p.read('src/lib/money.ts')).toContain('toFixed(3)');
    await store.undo();
    expect(p.read('src/lib/money.ts')).toBe(original);
  });

  it('stacks previews: keep keeps all, undo peels the newest', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'a', source: 'quick', edits: [edit(p, '$${n', 'USD ${n')] });
    await store.preview({ title: 'b', source: 'quick', edits: [edit(p, '−$', '-$')] });
    expect(store.previews()).toHaveLength(2);
    await store.undo();
    expect(p.read('src/lib/money.ts')).toContain('USD ');
    expect(p.read('src/lib/money.ts')).toContain('−$');
    const { kept } = store.keep();
    expect(kept.map((k) => k.title)).toEqual(['a']);
    expect(store.previews()).toHaveLength(0);
  });

  it('keeps previews across a restart of the studio, still undoable', async () => {
    const p = tempShop();
    const original = p.read('src/lib/money.ts');
    await new ChangeStore(p).preview({ title: 'a', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    const again = new ChangeStore(p);
    expect(again.restored).toBe(1);
    expect(again.previews().map((c) => c.title)).toEqual(['a']);
    await again.undo();
    expect(p.read('src/lib/money.ts')).toBe(original);
    expect(new ChangeStore(p).restored).toBe(0);
  });

  it('puts back a preview the studio stopped in the middle of writing', async () => {
    const p = tempShop();
    const store = new ChangeStore(p, async () => undefined);
    const money = p.read('src/lib/money.ts');
    const cart = p.read('src/lib/cart.ts');
    await store.preview({ title: 'two files', source: 'ai', edits: [edit(p, 'toFixed(2)', 'toFixed(3)'), { path: 'src/lib/cart.ts', before: cart, after: `${cart}\n// added\n` }] });
    // As if it had stopped after the first file: the second still holds its old code.
    p.write('src/lib/cart.ts', cart);
    const again = new ChangeStore(p);
    expect(again.restored).toBe(0);
    expect(again.list()[0].status).toBe('undone');
    expect(p.read('src/lib/money.ts')).toBe(money);
  });

  it('says how to undo a change kept in an earlier run', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    const c = await store.preview({ title: 'a', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    store.keep();
    await expect(new ChangeStore(p).undo(c.id)).rejects.toThrow(/earlier run of the studio/);
  });

  it('refuses to undo over edits made elsewhere', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'a', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    p.write('src/lib/money.ts', p.read('src/lib/money.ts') + '\n// edited in the editor\n');
    await expect(store.undo()).rejects.toThrow(/edited after this change/);
  });
});

describe('a change of several files', () => {
  it('asks the app to hold its page’s updates before any file changes, then puts them all in place', async () => {
    const p = tempShop();
    const money = p.read('src/lib/money.ts');
    const cart = p.read('src/lib/cart.ts');
    const asked: { url: string; files: string[]; money: string; cart: string }[] = [];
    const store = new ChangeStore(p, async (url, files) => void asked.push({ url, files, money: p.read('src/lib/money.ts'), cart: p.read('src/lib/cart.ts') }));
    await store.preview({ title: 'two files', source: 'ai', edits: [edit(p, 'toFixed(2)', 'toFixed(3)'), { path: 'src/lib/cart.ts', before: cart, after: `${cart}// added\n` }] });
    // Asked while both files still held what they had.
    expect(asked).toEqual([{ url: p.url, files: [p.resolve('src/lib/money.ts'), p.resolve('src/lib/cart.ts')], money, cart }]);
    expect(p.read('src/lib/money.ts')).toContain('toFixed(3)');
    expect(p.read('src/lib/cart.ts')).toContain('// added');
    // Undone together too.
    await store.undo();
    expect(asked).toHaveLength(2);
    expect([p.read('src/lib/money.ts'), p.read('src/lib/cart.ts')]).toEqual([money, cart]);
  });

  it('a change of one file is just written', async () => {
    const p = tempShop();
    const asked: string[][] = [];
    const store = new ChangeStore(p, async (_url, files) => void asked.push(files));
    await store.preview({ title: 'one', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    await store.undo();
    expect(asked).toEqual([]);
  });

  it('changes nothing when one of its files can’t be written', async () => {
    const p = tempShop();
    const money = p.read('src/lib/money.ts');
    const store = new ChangeStore(p, async () => undefined);
    // A file stands where the second file's folder would be.
    fs.writeFileSync(path.join(p.root, 'src/blocked'), 'a file, not a folder');
    await expect(store.preview({ title: 'two files', source: 'ai', edits: [edit(p, 'toFixed(2)', 'toFixed(3)'), { path: 'src/blocked/new.ts', before: null, after: 'x' }] })).rejects.toThrow();
    expect(p.read('src/lib/money.ts')).toBe(money);
    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(path.join(p.root, 'src/lib')).filter((f) => f.includes('saywright-tmp'))).toEqual([]);
  });
});

describe('committing kept changes', () => {
  it('commits alongside the studio, and says what git said when a hook refuses', async () => {
    const p = tempShop();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: p.root, stdio: 'pipe' }).toString();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    const store = new ChangeStore(p);

    await store.preview({ title: 'Three decimals', source: 'quick', said: 'more precise', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    expect(await store.commit(store.keep().kept)).toEqual({ committed: true });
    expect(git('log', '-1', '--format=%s')).toBe('Three decimals\n');

    const hook = path.join(p.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed: 2 problems" >&2\nexit 1\n', { mode: 0o755 });
    await store.preview({ title: 'Four decimals', source: 'quick', edits: [edit(p, 'toFixed(3)', 'toFixed(4)')] });
    expect(await store.commit(store.keep().kept)).toEqual({ committed: false, error: 'lint failed: 2 problems' });
  });

  it('does nothing outside a repository, and commits once the app becomes one', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'a', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    expect(await store.commit(store.keep().kept)).toEqual({ committed: false });

    // git init while the studio runs: noticed a few seconds later.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: p.root, stdio: 'pipe' }).toString();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ['Date'] });
    try {
      await store.preview({ title: 'Four decimals', source: 'quick', edits: [edit(p, 'toFixed(3)', 'toFixed(4)')] });
      expect(await store.commit(store.keep().kept)).toEqual({ committed: true });
    } finally {
      vi.useRealTimers();
    }
    expect(git('log', '-1', '--format=%s')).toBe('Four decimals\n');
  });
});
