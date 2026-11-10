/**
 * The list of linked apps is one file (apps.json): every app's name, folder, addresses and dev command. A damaged
 * file never empties it without a word, and two studios on one data folder never lose each other's apps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRegistry } from '../../server/apps/registry';

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-registry-'));
const app = (name: string) => ({ name, root: null, connection: 'proxy' as const, notes: [] });
const names = (r: AppRegistry) => r.list().map((a) => a.name).sort();

afterEach(() => vi.restoreAllMocks());

describe('a damaged app list', () => {
  it('is set aside, said, and its last good copy used: nothing is lost by the next save', () => {
    const dir = folder();
    const first = new AppRegistry(dir);
    first.add(app('shop'), { url: 'http://localhost:3000', start: null });
    first.add(app('admin'), { url: 'http://localhost:3001', start: null });
    const file = path.join(dir, 'apps.json');
    // A crash while it was being written, or a slip in an editor.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 200));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const again = new AppRegistry(dir);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/apps\.json was damaged and was moved to .*apps\.json\.broken-\d+\. Its last good copy is used instead\./));
    // The copy is from before the last save: the first app is there.
    expect(names(again)).toContain('shop');
    again.add(app('blog'), { url: 'http://localhost:3002', start: null });
    expect(names(new AppRegistry(dir))).toEqual(expect.arrayContaining(['blog', 'shop']));
    expect(fs.readdirSync(dir).some((f) => /^apps\.json\.broken-\d+$/.test(f))).toBe(true);
  });

  it('that parses but isn’t an app list is set aside too, never written over', () => {
    const dir = folder();
    const file = path.join(dir, 'apps.json');
    fs.writeFileSync(file, '{"apps":"none","note":"someone else’s file"}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new AppRegistry(dir);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('doesn’t hold an app list and was moved to'));
    registry.add(app('shop'), { url: 'http://localhost:3000', start: null });
    const aside = fs.readdirSync(dir).find((f) => /^apps\.json\.broken-\d+$/.test(f))!;
    expect(fs.readFileSync(path.join(dir, aside), 'utf8')).toContain('someone else’s file');
    expect(names(new AppRegistry(dir))).toEqual(['shop']);
  });

  it('a first run has no file and no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(new AppRegistry(folder()).list()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('two studios on one data folder', () => {
  it('keep each other’s apps, and what one unlinks stays unlinked', () => {
    const dir = folder();
    const a = new AppRegistry(dir);
    const b = new AppRegistry(dir);
    const shop = a.add(app('shop'), { url: 'http://localhost:3000', start: null });
    // B started before A linked anything, and now links its own.
    b.add(app('admin'), { url: 'http://localhost:3001', start: null });
    expect(names(new AppRegistry(dir))).toEqual(['admin', 'shop']);
    // B sees A's app from then on, and unlinks it.
    expect(names(b)).toEqual(['admin', 'shop']);
    b.remove(shop.id);
    // A still shows it until it next saves anything; then it is gone for A too, and B's app has joined A's list.
    a.launcher = false;
    expect(names(a)).toEqual(['admin']);
    expect(names(new AppRegistry(dir))).toEqual(['admin']);
  });
});
