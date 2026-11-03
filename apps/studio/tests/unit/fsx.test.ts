/**
 * The studio's own settings survive a bad save: files are replaced whole, the last good copy is kept, and a damaged
 * file is set aside (with a warning) instead of being silently replaced by defaults the next save would make permanent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connections } from '../../server/ai/connections';
import { loadEnvFiles, saveSecret } from '../../server/env';
import { readJson, writeFileAtomic, writeJson } from '../../server/fsx';

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-fsx-'));

describe('saving settings', () => {
  it('replaces the file whole and keeps the copy it replaced', () => {
    const dir = folder();
    const file = path.join(dir, 'ai.json');
    writeJson(file, { effort: 'low' });
    writeJson(file, { effort: 'high' });
    expect(readJson(file)).toEqual({ effort: 'high' });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual({ effort: 'low' });
    // Nothing half-written is left beside it.
    expect(fs.readdirSync(dir).sort()).toEqual(['ai.json', 'ai.json.bak']);
  });

  it('uses the last good copy when the file is damaged, and moves the damaged one aside', () => {
    const dir = folder();
    const file = path.join(dir, 'state.json');
    writeJson(file, { budget: 5 });
    writeJson(file, { budget: 10 });
    fs.writeFileSync(file, '{"budget": 1'); // torn: a crash in the middle of an old-style save
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readJson(file)).toEqual({ budget: 5 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/state\.json was damaged and was moved to .*state\.json\.broken-\d+\. Its last good copy is used instead\./));
    warn.mockRestore();
    expect(fs.readdirSync(dir).some((f) => /^state\.json\.broken-\d+$/.test(f))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('starts over when the file was removed on purpose', () => {
    const file = path.join(folder(), 'studio.json');
    writeJson(file, { speech: { en: 'a' } });
    writeJson(file, { speech: { en: 'b' } });
    fs.rmSync(file);
    expect(readJson(file)).toBeUndefined();
  });

  it('keeps AI settings when ai.json is damaged, and the next save writes them back', () => {
    const dir = folder();
    const file = path.join(dir, 'ai.json');
    const first = new Connections(file, dir);
    first.setEffort('high');
    first.setEffort('low');
    fs.writeFileSync(file, '{"routes":');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const after = new Connections(file, dir);
    warn.mockRestore();
    expect(after.config.effort).toBe('high');
    after.setEffort('medium');
    expect(readJson<{ effort: string }>(file)?.effort).toBe('medium');
  });

  it('writes secrets readable by this user only, without keeping removed keys anywhere', () => {
    const dir = folder();
    saveSecret(dir, 'OPENAI_API_KEY', 'sk-first');
    saveSecret(dir, 'OPENAI_API_KEY', null);
    const file = path.join(dir, '.env.local');
    // Windows has no such permission bits (a user's folders are theirs by its access rules).
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-first');
    expect(fs.readdirSync(dir)).toEqual(['.env.local']);
    delete process.env.OPENAI_API_KEY;
  });

  it('changes a key that .env.local sets twice (edited by hand) everywhere, so the new one is what loads next time', () => {
    const dir = folder();
    const file = path.join(dir, '.env.local');
    fs.writeFileSync(file, 'OPENAI_API_KEY=sk-old\nOTHER=1\nexport OPENAI_API_KEY=sk-older\n');
    saveSecret(dir, 'OPENAI_API_KEY', 'sk-new$&');
    expect(fs.readFileSync(file, 'utf8')).toBe('OPENAI_API_KEY=sk-new$&\nOTHER=1\n');
    delete process.env.OPENAI_API_KEY;
    loadEnvFiles(dir);
    expect(process.env.OPENAI_API_KEY).toBe('sk-new$&');
    saveSecret(dir, 'OPENAI_API_KEY', null);
    expect(fs.readFileSync(file, 'utf8')).toBe('OTHER=1\n');
    delete process.env.OTHER;
  });

  it('leaves the old file when a save can’t finish', () => {
    const dir = folder();
    const file = path.join(dir, 'decisions.json');
    writeFileAtomic(file, '{"skipped":[]}');
    // A folder where the file should be: the rename fails, the half-written copy goes.
    const blocked = path.join(dir, 'blocked');
    fs.mkdirSync(path.join(blocked, 'x.json'), { recursive: true });
    expect(() => writeFileAtomic(path.join(blocked, 'x.json'), '{}')).toThrow();
    expect(fs.readdirSync(blocked)).toEqual(['x.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"skipped":[]}');
  });
});

describe('keys in .env.local', () => {
  const names = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('a key saved from Settings wins over the shell’s, but an empty line never blanks one', () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, '.env.local'), 'OPENAI_API_KEY=\nGEMINI_API_KEY=from-settings\nGROQ_API_KEY=\n');
    process.env.OPENAI_API_KEY = 'sk-from-the-shell';
    process.env.GEMINI_API_KEY = 'from-the-shell';
    delete process.env.GROQ_API_KEY;
    loadEnvFiles(dir);
    expect(process.env.OPENAI_API_KEY).toBe('sk-from-the-shell');
    expect(process.env.GEMINI_API_KEY).toBe('from-settings');
    expect(process.env.GROQ_API_KEY).toBe('');
  });
});
