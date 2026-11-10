/**
 * The data folder and its files, as each command meets them: a folder it can't use is said in a sentence that names
 * it and SAYWRIGHT_HOME; a file of the wrong shape is set aside, so the studio starts with its defaults.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataDirProblem } from '../../cli/data-dir';
import { main, type CliContext } from '../../cli/index';
import { shortHome } from '../../cli/start';
import { createStudioApi } from '../../server/index';
import { repoLayout } from '../../server/layout';
import { checkDataFiles } from '../../server/data-check';

const ROOT = path.resolve(__dirname, '../../../..');
let out: string[] = [];
beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
});
afterEach(() => vi.restoreAllMocks());
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-data-'));
const ctxFor = (dataDir: string): CliContext => ({ layout: { ...repoLayout(ROOT), dataDir, envDir: dataDir }, clientDir: null, pluginSpec: 'x', startCommand: 'npx @saywright/studio' });

describe('a data folder Saywright can’t use', () => {
  it('a file where the folder should be: every command that writes it says so, with SAYWRIGHT_HOME, and stops', async () => {
    const file = path.join(temp(), 'afile');
    fs.writeFileSync(file, 'x');
    expect(dataDirProblem(file)).toMatch(/can’t use its data folder .*afile: it is a file, not a folder\. .*SAYWRIGHT_HOME/);
    for (const command of [['--no-open'], ['connect', temp()], ['setup', '--no-speech']]) {
      out = [];
      expect(await main(command, ctxFor(file))).toBe(1);
      expect(out.join('\n')).toMatch(/SAYWRIGHT_HOME/);
    }
    // doctor says it among its checks, and goes on with the others.
    out = [];
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await main(['doctor'], ctxFor(file))).toBe(1);
    expect(out.join('\n')).toMatch(/✗ Saywright can’t use its data folder/);
    expect(out.join('\n')).toMatch(/AI: /);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder it can’t write', () => {
    const dir = temp();
    fs.chmodSync(dir, 0o500);
    try {
      expect(dataDirProblem(dir)).toMatch(/belongs to another account, or isn’t writable/);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('data files of the wrong shape', () => {
  it('are set aside, and the studio starts with its defaults', async () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ routes: 'x', custom: 5, off: 'no', effort: 7 }));
    fs.mkdirSync(path.join(dir, 'usage'));
    fs.writeFileSync(path.join(dir, 'usage', '2026-11.jsonl'), `${JSON.stringify({ t: Date.now(), usd: 0.01, feature: 'change', connection: 'x', kind: 'api', model: 'm', plan: false, app: null })}\nnull\n`);
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const ai = process.env.SAYWRIGHT_AI;
    process.env.SAYWRIGHT_AI = 'fake';
    try {
      const studio = await createStudioApi({ ...repoLayout(ROOT), dataDir: dir, envDir: dir });
      expect(() => studio.status()).not.toThrow();
      studio.close();
    } finally {
      if (ai === undefined) delete process.env.SAYWRIGHT_AI;
      else process.env.SAYWRIGHT_AI = ai;
    }
    expect(out.join('\n')).toMatch(/ai\.json wasn’t in the shape the studio reads and was moved to/);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('ai.json.broken-'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'usage', '2026-11.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('a well-formed file, and a torn last line, are left as they are', () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ custom: [], routes: {}, effort: 'medium', off: [] }));
    fs.mkdirSync(path.join(dir, 'usage'));
    const log = `${JSON.stringify({ t: 1 })}\n{"t": 2, "us`;
    fs.writeFileSync(path.join(dir, 'usage', '2026-10.jsonl'), log);
    const said: string[] = [];
    checkDataFiles(dir, (l) => said.push(l));
    expect(said).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'usage', '2026-10.jsonl'), 'utf8')).toBe(log);
  });
});

describe('the command line', () => {
  it('takes a port written as digits only', async () => {
    const client = temp();
    fs.writeFileSync(path.join(client, 'index.html'), '<!doctype html>');
    for (const port of ['1e3', '0x1D10', ' 7441 ', '7441.0']) {
      out = [];
      expect(await main(['--port', port, '--no-open'], { ...ctxFor(temp()), clientDir: client }), port).toBe(1);
      expect(out.join('\n')).toMatch(/--port takes a number from 1 to 65535/);
    }
  });

  it('shortens the data folder to ~ only under the home folder', () => {
    expect(shortHome('/home/alice/.saywright', '/home/al')).toBe('/home/alice/.saywright');
    expect(shortHome('/home/al/.saywright', '/home/al')).toBe(`~${path.sep}.saywright`);
    expect(shortHome('/home/al', '/home/al')).toBe('~');
  });
});
