/**
 * A change never costs a file a byte it didn't mean to change: files that aren't UTF-8 (a legacy page in Latin-1),
 * binary files, and files with Windows line ends, through every writer that goes through the change store, and back
 * again with Undo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEditSpecs, readFileTool, searchTool } from '../../server/ai/tools';
import { userMessage } from '../../server/ai/context';
import { ChangeStore } from '../../server/changes';
import { Project } from '../../server/project';
import { eolOf, lfView } from '../../server/text-file';

/** A project with these files (bytes, or text written as UTF-8), and its data kept outside it. */
function project(files: Record<string, Buffer | string>): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-enc-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-enc-data-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return new Project(root, 'http://localhost:1', data);
}
const bytes = (p: Project, file: string) => fs.readFileSync(path.join(p.root, file));
const store = (p: Project) => new ChangeStore(p, async () => undefined);

// “Café du Marché”, a price in Windows-1252 (0x80 is its euro sign) and a title to change, as a legacy PHP page has them.
const LATIN1 = Buffer.from('<h1>Caf\xe9 du March\xe9</h1>\n<p class="price">Prix: 10 \x80</p>\n<title>Old title</title>\n', 'latin1');
// A real PNG's first bytes (its header has NUL bytes) with text further in.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64, 0xff), Buffer.from('tEXtComment\0logo v1')]);

describe('a file that isn’t UTF-8', () => {
  it('is shown to the model with its accents, and says what can be written in it', () => {
    const p = project({ 'index.php': LATIN1 });
    const shown = readFileTool(p, 'index.php');
    expect(shown).toContain('<h1>Café du Marché</h1>');
    expect(shown).not.toContain('�');
    expect(shown.split('\n')[0]).toBe('index.php (lines 1-4 of 4; not UTF-8: read as Latin-1, so only characters up to U+00FF can be written in it)');
    expect(userMessage({ text: 'change the title', refs: [{ role: 'this', name: 'title', label: 'title', text: 'Old title', src: 'index.php:3:1' } as never], mode: 'edit' }, p)).toMatch(/--- index\.php \(all 4 lines; not UTF-8: read as Latin-1/);
  });

  it('keeps every byte the change didn’t touch, and Undo puts back the very bytes that were there', async () => {
    const p = project({ 'index.php': LATIN1 });
    const s = store(p);
    const change = await s.preview({ title: 'Title', source: 'ai', edits: applyEditSpecs(p, [{ path: 'index.php', old_string: 'Old title', new_string: 'Nouveau café' }]) });
    const after = bytes(p, 'index.php');
    expect(after.equals(Buffer.from(LATIN1.toString('latin1').replace('Old title', 'Nouveau caf\xe9'), 'latin1'))).toBe(true);
    // “é” is still one byte (0xE9), the euro sign still 0x80: nothing became U+FFFD.
    expect(after.subarray(0, 8).toString('hex')).toBe('3c68313e436166e9');
    expect(after.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(change.files[0]).toMatchObject({ added: 1, removed: 1 });
    await s.undo(change.id);
    expect(bytes(p, 'index.php').equals(LATIN1)).toBe(true);
  });

  it('is kept by every other writer too: a quick edit’s text goes back as the bytes it came from', async () => {
    const p = project({ 'index.php': LATIN1 });
    const s = store(p);
    // As quick edits and the Inspector make a change: the file's text, and the same text with one thing replaced.
    const before = p.read('index.php');
    const change = await s.preview({ title: 'Quick', source: 'quick', edits: [{ path: 'index.php', before, after: before.replace('Prix', 'Price') }] });
    expect(bytes(p, 'index.php').equals(Buffer.from(LATIN1.toString('latin1').replace('Prix', 'Price'), 'latin1'))).toBe(true);
    await s.undo(change.id);
    expect(bytes(p, 'index.php').equals(LATIN1)).toBe(true);
  });

  it('refuses a character its encoding can’t hold, with why and what to do, and writes nothing', async () => {
    const p = project({ 'index.php': LATIN1 });
    expect(() => applyEditSpecs(p, [{ path: 'index.php', old_string: 'Old title', new_string: 'Prix: 10 €' }])).toThrow(/index\.php isn’t saved as UTF-8 \(it is read as Latin-1\), and new_string has a character it can’t hold: “€” \(U\+20AC\)\. .* saved as UTF-8 first\./);
    // Whoever writes it: the store itself refuses, in words for the person.
    const before = p.read('index.php');
    const refused = await store(p)
      .preview({ title: 'Quick', source: 'quick', edits: [{ path: 'index.php', before, after: before.replace('Old title', 'Menu ☕') }] })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: 'encoding', message: 'index.php isn’t saved as UTF-8, and this change adds a character its encoding can’t hold: “☕” (U+2615) can’t be written in Latin-1. Nothing was written. Save the file as UTF-8 in your editor, then ask again.' });
    expect(bytes(p, 'index.php').equals(LATIN1)).toBe(true);
  });

  it('is told apart from another save of it by its bytes: a change made from the file as it was is not written over', async () => {
    const p = project({ 'index.php': LATIN1 });
    const s = store(p);
    const edits = applyEditSpecs(p, [{ path: 'index.php', old_string: 'Old title', new_string: 'New title' }]);
    // Saved in an editor meanwhile: one accent changed (é to è), which a lossy read can't tell from what was there.
    const saved = Buffer.from(LATIN1.toString('latin1').replace('Caf\xe9', 'Caf\xe8'), 'latin1');
    fs.writeFileSync(path.join(p.root, 'index.php'), saved);
    await expect(s.preview({ title: 'Title', source: 'ai', edits })).rejects.toMatchObject({ code: 'stale' });
    expect(bytes(p, 'index.php').equals(saved)).toBe(true);
    // And an undo over a file saved since, the same way.
    const change = await s.preview({ title: 'Title', source: 'ai', edits: applyEditSpecs(p, [{ path: 'index.php', old_string: 'Old title', new_string: 'New title' }]) });
    const again = Buffer.from(bytes(p, 'index.php').toString('latin1').replace('Caf\xe8', 'Caf\xe9'), 'latin1');
    fs.writeFileSync(path.join(p.root, 'index.php'), again);
    await expect(s.undo(change.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(bytes(p, 'index.php').equals(again)).toBe(true);
  });

  it('comes back byte for byte after a restart of the studio too', async () => {
    const p = project({ 'index.php': LATIN1 });
    await store(p).preview({ title: 'Title', source: 'ai', edits: applyEditSpecs(p, [{ path: 'index.php', old_string: 'Old title', new_string: 'New title' }]) });
    const again = store(p);
    expect(again.restored).toBe(1);
    await again.undo();
    expect(bytes(p, 'index.php').equals(LATIN1)).toBe(true);
  });

  it('is found by a search with its accents as they are', async () => {
    const p = project({ 'index.php': LATIN1 });
    expect(await searchTool(p, 'march')).toBe('index.php:1: <h1>Café du Marché</h1>');
  });
});

describe('a UTF-8 file', () => {
  it('is read and written as before: any character, and a byte order mark kept', async () => {
    const text = '﻿.a::before { content: "Café ☕ — 10 €" }\n';
    const p = project({ 'bom.css': text });
    const s = store(p);
    const change = await s.preview({ title: 'bom', source: 'ai', edits: applyEditSpecs(p, [{ path: 'bom.css', old_string: '10 €', new_string: '12 € ✓' }]) });
    expect(bytes(p, 'bom.css').toString('utf8')).toBe(text.replace('10 €', '12 € ✓'));
    expect(bytes(p, 'bom.css').subarray(0, 3).toString('hex')).toBe('efbbbf');
    await s.undo(change.id);
    expect(bytes(p, 'bom.css').equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it('a preview journaled by 0.2.x (as text) is still there after the upgrade, and still undone exactly', async () => {
    const p = project({ 'a.css': '.a { color: blue }\n' });
    const change = { id: 'abc12345', title: 'Blue', source: 'ai', files: [], status: 'preview', createdAt: 1 };
    fs.writeFileSync(path.join(p.stateDir(), 'changes.json'), JSON.stringify({ v: 1, changes: [change], edits: { abc12345: [{ path: 'a.css', before: '.a { color: red — “é” }\n', after: '.a { color: blue }\n' }] } }));
    const s = store(p);
    expect(s.restored).toBe(1);
    await s.undo();
    expect(bytes(p, 'a.css').toString('utf8')).toBe('.a { color: red — “é” }\n');
  });
});

describe('a binary file', () => {
  it('is never shown to the model and never edited', async () => {
    const p = project({ 'logo.png': PNG, 'data/blob.txt': Buffer.from('some text\0then more') });
    expect(() => readFileTool(p, 'logo.png')).toThrow('logo.png is a binary file, not text: it can’t be read or changed here.');
    expect(() => readFileTool(p, 'data/blob.txt')).toThrow(/data\/blob\.txt is a binary file, not text/);
    expect(() => applyEditSpecs(p, [{ path: 'logo.png', old_string: 'logo v1', new_string: 'logo v2' }])).toThrow(/logo\.png is a binary file/);
    expect(() => applyEditSpecs(p, [{ path: 'new.png', old_string: '', new_string: 'not a picture' }])).toThrow(/new\.png is a binary file by its name/);
    // Not through the store either, whoever made the edit.
    const text = PNG.toString('latin1');
    await expect(store(p).preview({ title: 'png', source: 'quick', edits: [{ path: 'logo.png', before: text, after: text.replace('logo v1', 'logo v2') }] })).rejects.toMatchObject({ code: 'not-text' });
    expect(bytes(p, 'logo.png').equals(PNG)).toBe(true);
    expect(await searchTool(p, 'then more')).toMatch(/^No matches/);
  });

  it('a UTF-16 file is refused by its name, with what to do', () => {
    const p = project({ 'strings.json': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"greeting": "Hello"}\n', 'utf16le')]) });
    expect(() => readFileTool(p, 'strings.json')).toThrow('strings.json is saved as UTF-16, which can’t be read or changed here. Save it as UTF-8 first.');
    expect(() => applyEditSpecs(p, [{ path: 'strings.json', old_string: 'Hello', new_string: 'Hi' }])).toThrow(/UTF-16/);
  });
});

describe('a file with Windows line ends', () => {
  const CRLF = 'function a() {\r\n  return 1\r\n}\r\n\r\nfunction b() {\r\n  return 2\r\n}\r\n';
  const ends = (text: string) => ({ crlf: (text.match(/\r\n/g) ?? []).length, bareLf: (text.match(/(?<!\r)\n/g) ?? []).length });

  it('is shown to the model with LF only', () => {
    const p = project({ 'crlf.js': CRLF });
    expect(readFileTool(p, 'crlf.js')).not.toContain('\r');
    expect(userMessage({ text: 'x', refs: [{ role: 'this', name: 'a', label: 'a', text: '', src: 'crlf.js:1:1' } as never], mode: 'edit' }, p)).not.toContain('\r');
  });

  it('takes an edit of several lines written with LF, and stays CRLF throughout', async () => {
    const p = project({ 'crlf.js': CRLF });
    const s = store(p);
    const edits = applyEditSpecs(p, [
      { path: 'crlf.js', old_string: 'function a() {\n  return 1\n}', new_string: 'function a() {\n  const one = 1\n  return one\n}' },
      { path: 'crlf.js', old_string: '  return 2', new_string: '  const two = 2\n  return two' },
    ]);
    const change = await s.preview({ title: 'crlf', source: 'ai', edits });
    const text = bytes(p, 'crlf.js').toString('utf8');
    expect(text).toBe('function a() {\r\n  const one = 1\r\n  return one\r\n}\r\n\r\nfunction b() {\r\n  const two = 2\r\n  return two\r\n}\r\n');
    expect(ends(text)).toEqual({ crlf: 9, bareLf: 0 });
    await s.undo(change.id);
    expect(bytes(p, 'crlf.js').toString('utf8')).toBe(CRLF);
  });

  it('takes an edit the model wrote with CRLF as well, and one that ends on a line end', () => {
    const p = project({ 'crlf.js': CRLF });
    const [a] = applyEditSpecs(p, [{ path: 'crlf.js', old_string: '  return 1\r\n}\r\n', new_string: '  return 10\r\n}\r\n' }]);
    expect(a.after).toBe(CRLF.replace('return 1', 'return 10'));
    const [b] = applyEditSpecs(p, [{ path: 'crlf.js', old_string: '}\n\nfunction b', new_string: '}\nfunction b' }]);
    expect(b.after).toBe(CRLF.replace('}\r\n\r\nfunction b', '}\r\nfunction b'));
  });

  it('leaves every other line’s end as it was in a file that mixes them, and an LF file stays LF', () => {
    const mixed = 'one\r\ntwo\nthree\r\nfour\r\n';
    const p = project({ 'mixed.txt': mixed, 'lf.js': 'const a = 1\nconst b = 2\n' });
    const [m] = applyEditSpecs(p, [{ path: 'mixed.txt', old_string: 'three', new_string: 'three\nand a half' }]);
    expect(m.after).toBe('one\r\ntwo\nthree\r\nand a half\r\nfour\r\n');
    const [l] = applyEditSpecs(p, [{ path: 'lf.js', old_string: 'const b = 2', new_string: 'const b = 2\r\nconst c = 3' }]);
    expect(l.after).toBe('const a = 1\nconst b = 2\nconst c = 3\n');
  });

  it('maps a place in the LF text to its place in the file', () => {
    const view = lfView('a\r\nb\r\nc');
    expect(view.lf).toBe('a\nb\nc');
    expect([0, 1, 2, 3, 4, 5].map(view.at)).toEqual([0, 1, 3, 4, 6, 7]);
    expect(eolOf('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(eolOf('a\nb\r\nc\n')).toBe('\n');
    expect(eolOf('no line end')).toBe('\n');
  });
});

describe('one file written two ways in one change', () => {
  it('is edited once, in order, and written once', async () => {
    const p = project({ 'a.js': 'const one = 1\nconst two = 2\n' });
    const edits = applyEditSpecs(p, [
      { path: 'a.js', old_string: 'const one = 1', new_string: 'const one = 11' },
      { path: 'x/../a.js', old_string: 'const two = 2', new_string: 'const two = 22' },
    ]);
    expect(edits).toEqual([{ path: 'a.js', before: 'const one = 1\nconst two = 2\n', after: 'const one = 11\nconst two = 22\n' }]);
    await store(p).preview({ title: 'twice', source: 'ai', edits });
    expect(bytes(p, 'a.js').toString('utf8')).toBe('const one = 11\nconst two = 22\n');
  });
});
