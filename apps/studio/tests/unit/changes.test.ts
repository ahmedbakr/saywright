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

describe.skipIf(process.platform === 'win32')('a file’s link and mode', () => {
  it('a change to a linked file goes to the file it leads to, the link stays a link, and modes are kept, through Undo', async () => {
    const p = tempShop();
    const at = (f: string) => path.join(p.root, f);
    fs.writeFileSync(at('src/config.dev.ts'), 'export const env = "dev";\n');
    fs.symlinkSync('config.dev.ts', at('src/config.ts'));
    fs.writeFileSync(at('src/run.ts'), '#!/usr/bin/env node\nconsole.log(1);\n', { mode: 0o755 });
    fs.chmodSync(at('src/run.ts'), 0o755);
    fs.writeFileSync(at('src/secret.ts'), 'export const key = "k";\n');
    fs.chmodSync(at('src/secret.ts'), 0o600);
    const mode = (f: string) => (fs.statSync(at(f)).mode & 0o777).toString(8);
    const store = new ChangeStore(p);
    const change = (f: string, a: string, b: string) => ({ path: f, before: p.read(f), after: p.read(f).replace(a, b) });
    await store.preview({ title: 'three', source: 'ai', edits: [change('src/config.ts', 'dev', 'prod'), change('src/run.ts', '1', '2'), change('src/secret.ts', '"k"', '"j"')] });
    expect(fs.lstatSync(at('src/config.ts')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(at('src/config.dev.ts'), 'utf8')).toContain('prod');
    expect([mode('src/run.ts'), mode('src/secret.ts')]).toEqual(['755', '600']);
    await store.undo();
    expect(fs.lstatSync(at('src/config.ts')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(at('src/config.dev.ts'), 'utf8')).toContain('dev');
    expect([mode('src/run.ts'), mode('src/secret.ts')]).toEqual(['755', '600']);
    p.write('src/run.ts', 'x');
    expect(mode('src/run.ts')).toBe('755');
  });
});

describe('when the journal can’t be written, or the app’s folder is gone', () => {
  it('a preview fails whole, Keep keeps nothing, and Undo of a real preview still works', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'A', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    await store.preview({ title: 'A2', source: 'quick', edits: [edit(p, 'toFixed(3)', 'toFixed(4)')] });
    const afterA2 = p.read('src/lib/money.ts');
    // The data folder can't take the journal any more (a full disk, say): its place is taken by a folder.
    const journal = path.join(p.root, '.saywright', 'changes.json');
    fs.rmSync(journal);
    fs.mkdirSync(path.join(journal, 'x'), { recursive: true });
    await expect(store.preview({ title: 'B', source: 'quick', edits: [edit(p, 'toFixed(4)', 'toFixed(5)')] })).rejects.toThrow(/couldn’t save its list of changes in .*\.saywright.*nothing was written/);
    expect(p.read('src/lib/money.ts')).toBe(afterA2);
    expect(store.list().map((c) => `${c.title}:${c.status}`)).toEqual(['A2:preview', 'A:preview']);
    expect(() => store.keep()).toThrow(/couldn’t save its list of changes .*nothing was kept/);
    expect(store.list().map((c) => `${c.title}:${c.status}`)).toEqual(['A2:preview', 'A:preview']);
    const undone = await store.undo();
    expect(undone.map((c) => c.title)).toEqual(['A2']);
    expect(p.read('src/lib/money.ts')).toContain('toFixed(3)');
    expect(store.list().map((c) => `${c.title}:${c.status}`)).toEqual(['A2:undone', 'A:preview']);
  });

  it('nothing recreates the app’s folder when it is moved away: every request says it is gone', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'A', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    const moved = `${p.root}-moved`;
    fs.renameSync(p.root, moved);
    const gone = `The app’s folder isn’t there any more (${p.root}): put it back, or link the app again.`;
    await expect(store.undo()).rejects.toThrow(gone);
    expect(() => store.keep()).toThrow(gone);
    await expect(store.preview({ title: 'B', source: 'quick', edits: [{ path: 'src/new.ts', before: null, after: 'x' }] })).rejects.toThrow(gone);
    expect(() => p.read('src/lib/money.ts')).toThrow(gone);
    expect(() => p.stateDir()).toThrow(gone);
    expect(fs.existsSync(p.root)).toBe(false);
    fs.renameSync(moved, p.root);
    expect((await store.undo()).map((c) => c.title)).toEqual(['A']);
  });
});

describe('memory stays flat over a long day', () => {
  it('keeps what Undo needs only for the most recent kept changes, and older ones say they can’t be undone here', async () => {
    const saved = ChangeStore.undoAllowance;
    ChangeStore.undoAllowance = { changes: 3, bytes: 1024 * 1024 };
    try {
      const p = tempShop();
      const store = new ChangeStore(p);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const before = p.read('src/lib/money.ts');
        ids.push((await store.preview({ title: `n${i}`, source: 'quick', edits: [{ path: 'src/lib/money.ts', before, after: `${before}// ${i}\n` }] })).id);
        store.keep();
      }
      const by = new Map(store.list().map((c) => [c.title, c.undoable]));
      expect([...by]).toEqual([['n5', true], ['n4', true], ['n3', true], ['n2', false], ['n1', false], ['n0', false]]);
      await expect(store.undo(ids[1])).rejects.toThrow(/can no longer be undone here: the studio keeps what Undo needs only for the last 3 changes you kept/);
      // A preview is always undoable, whatever the allowance.
      const before = p.read('src/lib/money.ts');
      const preview = await store.preview({ title: 'p', source: 'quick', edits: [{ path: 'src/lib/money.ts', before, after: `${before}// p\n` }] });
      expect(preview.undoable).toBe(true);
      // Too large for the allowance: kept, and said not to be undoable.
      ChangeStore.undoAllowance = { changes: 3, bytes: 10 };
      store.keep();
      expect(store.list()[0]).toMatchObject({ title: 'p', status: 'kept', undoable: false });
    } finally {
      ChangeStore.undoAllowance = saved;
    }
  });

  it('a new preview writes only its own contents, never every waiting preview’s again', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    const big = Array.from({ length: 5000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(p.root, 'src/big.ts'), `// ${big}\n`);
    const a = await store.preview({ title: 'big', source: 'quick', edits: [{ path: 'src/big.ts', before: p.read('src/big.ts'), after: `// ${big}\n// y\n` }] });
    const dir = path.join(p.stateDir(), 'changes.d');
    const first = fs.statSync(path.join(dir, `${a.id}.json`));
    await store.preview({ title: 'small', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    expect(fs.statSync(path.join(dir, `${a.id}.json`)).mtimeMs).toBe(first.mtimeMs);
    expect(fs.statSync(path.join(p.stateDir(), 'changes.json')).size).toBeLessThan(20_000);
    // Both come back after a restart, still undoable; once decided, their contents are let go.
    const again = new ChangeStore(p);
    expect(again.previews().map((c) => c.title)).toEqual(['big', 'small']);
    await again.undo();
    await again.undo();
    expect(p.read('src/big.ts')).toBe(`// ${big}\n`);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps the list to its last changes in memory too', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    for (let i = 0; i < 205; i++) {
      const before = p.read('src/lib/money.ts');
      await store.preview({ title: `n${i}`, source: 'quick', edits: [{ path: 'src/lib/money.ts', before, after: `${before}//${i}\n` }] });
      store.keep();
    }
    expect(store.list()).toHaveLength(200);
    expect(store.list().at(-1)?.title).toBe('n5');
    // More than a thousand files written and kept safe: a quarter of a minute where every new file is scanned.
  }, 60_000);
});

describe('what a change leaves behind', () => {
  it('leftovers of a write the studio was stopped in are cleared when the app is opened', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'a', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    fs.writeFileSync(path.join(p.root, 'src/lib/money.ts.saywright-tmp'), 'half');
    const stale = path.join(p.stateDir(), 'changes.json.999999999-1.tmp');
    fs.writeFileSync(stale, '{');
    const again = new ChangeStore(p);
    expect(again.previews()).toHaveLength(1);
    expect(fs.existsSync(path.join(p.root, 'src/lib/money.ts.saywright-tmp'))).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('Undo of a change that made a file in new folders removes the folders it made, and only those', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    fs.mkdirSync(path.join(p.root, 'src/empty'));
    await store.preview({ title: 'new', source: 'ai', edits: [{ path: 'src/new/deep/New.tsx', before: null, after: 'x' }, { path: 'src/empty/A.ts', before: null, after: 'y' }] });
    await store.undo();
    expect(fs.existsSync(path.join(p.root, 'src/new'))).toBe(false);
    expect(fs.existsSync(path.join(p.root, 'src/empty'))).toBe(true);
    expect(fs.existsSync(path.join(p.root, 'src/empty/A.ts'))).toBe(false);
  });

  it('Undo says a file is gone, not that it was edited', async () => {
    const p = tempShop();
    const store = new ChangeStore(p);
    await store.preview({ title: 'a', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    fs.rmSync(path.join(p.root, 'src/lib/money.ts'));
    await expect(store.undo()).rejects.toThrow('src/lib/money.ts isn’t there any more (deleted or moved since this change), so there is nothing to undo in it. Undo anyway puts it back as it was before the change.');
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
    // What was staged for it is unstaged again: the person's index is as it was.
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(git('status', '--porcelain')).toBe(' M src/lib/money.ts\n');
  });

  const repo = () => {
    const p = tempShop();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: p.root, stdio: 'pipe' }).toString();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    return { p, git };
  };

  it('commits only the change: never a file of the person’s own, nor their work in the same file', async () => {
    const { p, git } = repo();
    const store = new ChangeStore(p);
    // Their own unfinished work in another file stays theirs.
    fs.appendFileSync(path.join(p.root, 'src/App.tsx'), '// mine\n');
    await store.preview({ title: 'Three decimals', source: 'quick', edits: [edit(p, 'toFixed(2)', 'toFixed(3)')] });
    expect(await store.commit(store.keep().kept)).toEqual({ committed: true });
    expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('src/lib/money.ts\n');
    expect(git('status', '--porcelain')).toBe(' M src/App.tsx\n');

    // Their unsaved work in the very file the change touches: kept, not committed.
    fs.appendFileSync(path.join(p.root, 'src/lib/money.ts'), '// debug\n');
    await store.preview({ title: 'Four decimals', source: 'quick', edits: [edit(p, 'toFixed(3)', 'toFixed(4)')] });
    const r = await store.commit(store.keep().kept);
    expect(r).toEqual({ committed: false, note: 'Kept, not committed: src/lib/money.ts also has changes of yours that aren’t committed.' });
    expect(git('log', '-1', '--format=%s')).toBe('Three decimals\n');
    expect(git('diff', '--cached', '--name-only')).toBe('');

    // Staged work of theirs counts the same.
    git('checkout', '-q', '--', 'src/lib/money.ts');
    const before = p.read('src/lib/money.ts');
    fs.writeFileSync(path.join(p.root, 'src/lib/money.ts'), `// staged\n${before}`);
    git('add', 'src/lib/money.ts');
    fs.writeFileSync(path.join(p.root, 'src/lib/money.ts'), before);
    await store.preview({ title: 'Five', source: 'quick', edits: [edit(p, 'toFixed(3)', 'toFixed(5)')] });
    expect(await store.commit(store.keep().kept)).toMatchObject({ committed: false, note: expect.stringMatching(/^Kept, not committed: src\/lib\/money.ts also has changes of yours/) });
    expect(git('diff', '--cached', '--name-only')).toBe('src/lib/money.ts\n');
  });

  it('never commits into a repository above the app that doesn’t track it (a home folder kept in git)', async () => {
    const p = tempShop();
    const home = path.dirname(p.root);
    const outer = fs.mkdtempSync(path.join(home, 'saywright-home-'));
    const app = path.join(outer, 'projects', 'shop');
    fs.mkdirSync(path.dirname(app), { recursive: true });
    fs.renameSync(p.root, app);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: outer, stdio: 'pipe' }).toString();
    fs.writeFileSync(path.join(outer, '.bashrc'), 'alias ll=ls\n');
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.bashrc');
    git('commit', '-q', '-m', 'dotfiles');
    const { Project } = await import('../../server/project');
    const shop = new Project(app, 'http://localhost:5174');
    const store = new ChangeStore(shop);
    await store.preview({ title: 'Three decimals', source: 'quick', edits: [edit(shop as never, 'toFixed(2)', 'toFixed(3)')] });
    const r = await store.commit(store.keep().kept);
    expect(r).toMatchObject({ committed: false, note: expect.stringMatching(/^Kept, not committed: the git repository at .* doesn’t track this app’s folder\.$/) });
    expect(git('log', '--format=%s')).toBe('dotfiles\n');
    expect(git('ls-files')).toBe('.bashrc\n');
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
