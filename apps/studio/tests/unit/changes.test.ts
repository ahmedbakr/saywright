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

  it('says when a preview is made, kept or undone (every open studio tab catches up), and not when nothing changed', async () => {
    const p = tempShop();
    const told = vi.fn();
    const store = new ChangeStore(p, async () => undefined, told);
    await store.preview({ title: 'a', source: 'quick', edits: [edit(p, '$${n', 'USD ${n')] });
    expect(told).toHaveBeenCalledTimes(1);
    await store.preview({ title: 'b', source: 'quick', edits: [edit(p, '−$', '-$')] });
    await store.undo();
    store.keep();
    expect(told).toHaveBeenCalledTimes(4);
    await expect(store.preview({ title: 'none', source: 'quick', edits: [edit(p, 'nothing like this', '')] })).rejects.toThrow();
    expect(() => store.keep()).toThrow();
    expect(told).toHaveBeenCalledTimes(4);
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

  it('writes a change through a link inside the project to the file it leads to: the link stays a link, through undo too', async () => {
    const p = tempShop();
    const real = path.join(p.root, 'src', 'lib', 'money.ts');
    const original = fs.readFileSync(real, 'utf8');
    const link = path.join(p.root, 'src', 'money-link.ts');
    fs.symlinkSync('lib/money.ts', link);
    const store = new ChangeStore(p, async () => undefined);
    const before = p.read('src/money-link.ts');
    const change = await store.preview({ title: 'linked', source: 'ai', edits: [{ path: 'src/money-link.ts', before, after: before.replace('toFixed(2)', 'toFixed(3)') }] });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(original.replace('toFixed(2)', 'toFixed(3)'));
    await store.undo(change.id);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(original);
  });

  it('refuses to undo over edits made elsewhere', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'a', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    p.write('src/lib/money.ts', p.read('src/lib/money.ts') + '\n// edited in the editor\n');
    await expect(store.undo()).rejects.toThrow(/edited after this change/);
  });
});

describe('a change made from files saved since', () => {
  it('is never written over what was saved: refused, nothing written, and undo has nothing of it to put back', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    const original = p.read('src/lib/money.ts');
    // Made from the file as it was, then the file is saved in an editor before the change is written.
    const prepared = edit(p, 'toFixed(2)', 'toFixed(3)');
    const saved = `${original}// saved in the editor\n`;
    p.write('src/lib/money.ts', saved);
    const refused = await store.preview({ title: 'late', source: 'ai', edits: [prepared] }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: 'stale', message: expect.stringMatching(/^src\/lib\/money\.ts changed while this change was being made .* nothing was lost\. Ask again/) });
    expect(p.read('src/lib/money.ts')).toBe(saved);
    expect(store.list()).toEqual([]);
    await expect(store.undo()).rejects.toThrow(/Nothing to undo/);
    expect(p.read('src/lib/money.ts')).toBe(saved);
  });

  it('two changes made from the same file at once: the second is refused, not written over the first', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    const a = edit(p, 'toFixed(2)', 'toFixed(3)');
    const b = edit(p, '$${n', 'USD ${n');
    const [first, second] = await Promise.allSettled([store.preview({ title: 'a', source: 'ai', edits: [a] }), store.preview({ title: 'b', source: 'quick', edits: [b] })]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'stale' } });
    expect(p.read('src/lib/money.ts')).toBe(a.after);
    expect(store.previews().map((c) => c.title)).toEqual(['a']);
  });

  it('a file to be created that was created meanwhile, or one deleted meanwhile, is refused too', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    p.write('src/lib/new.ts', 'export const mine = 1;\n');
    await expect(store.preview({ title: 'new', source: 'ai', edits: [{ path: 'src/lib/new.ts', before: null, after: 'export const theirs = 2;\n' }] })).rejects.toThrow(/^src\/lib\/new\.ts was created while/);
    expect(p.read('src/lib/new.ts')).toBe('export const mine = 1;\n');
    const money = edit(p, 'toFixed(2)', 'toFixed(3)');
    fs.unlinkSync(p.resolve('src/lib/money.ts'));
    await expect(store.preview({ title: 'gone', source: 'ai', edits: [money] })).rejects.toThrow(/^src\/lib\/money\.ts was deleted while/);
    expect(p.exists('src/lib/money.ts')).toBe(false);
  });

  it('is checked again right before writing: a file saved while the page’s updates were being held is not written over', async () => {
    const p = tempShop();
    const cart = p.read('src/lib/cart.ts');
    const saved = `${cart}// saved while waiting\n`;
    // The app takes a moment to hold its page's updates, and the file is saved in that moment.
    const store = new ChangeStore(p, async () => void p.write('src/lib/cart.ts', saved));
    const money = p.read('src/lib/money.ts');
    await expect(store.preview({ title: 'two files', source: 'ai', edits: [edit(p, 'toFixed(2)', 'toFixed(3)'), { path: 'src/lib/cart.ts', before: cart, after: `${cart}// added\n` }] })).rejects.toMatchObject({ code: 'stale' });
    expect([p.read('src/lib/money.ts'), p.read('src/lib/cart.ts')]).toEqual([money, saved]);
    expect(store.list()).toEqual([]);
  });

  it('undo is checked again right before writing too', async () => {
    const p = tempShop();
    let save: (() => void) | null = null;
    const store = new ChangeStore(p, async () => save?.());
    const cart = p.read('src/lib/cart.ts');
    await store.preview({ title: 'two files', source: 'ai', edits: [edit(p, 'toFixed(2)', 'toFixed(3)'), { path: 'src/lib/cart.ts', before: cart, after: `${cart}// added\n` }] });
    const saved = `${cart}// added\n// and saved in the editor\n`;
    save = () => p.write('src/lib/cart.ts', saved);
    await expect(store.undo()).rejects.toMatchObject({ code: 'conflict' });
    expect(p.read('src/lib/cart.ts')).toBe(saved);
    expect(p.read('src/lib/money.ts')).toContain('toFixed(3)');
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
