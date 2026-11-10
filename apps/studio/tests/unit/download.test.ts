/**
 * Model downloads: a dropped connection is continued where it stopped, a failure says why, and what a stopped
 * download left behind is removed by name only.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { download, missingUnpackers, removePartials } from '../../server/download';
import { programs } from './helpers';

const BODY = Buffer.alloc(4 << 20, 7).map((_, i) => i % 251);
const SHA = createHash('sha256').update(BODY).digest('hex');
const servers: http.Server[] = [];
let path$: { restore: () => void } | null = null;
afterEach(async () => {
  path$?.restore();
  path$ = null;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.tar.bz2`;
}
const dest = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-dl-')), 'model.tar.bz2');

describe('a model download', () => {
  it('continues where a dropped connection stopped it, with a Range request', async () => {
    const asked: string[] = [];
    const url = await serve((req, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      asked.push(req.headers.range ?? '(whole)');
      if (!range) {
        // Half the file, then the connection drops.
        res.writeHead(200, { 'Content-Length': BODY.length });
        res.write(BODY.subarray(0, BODY.length / 2), () => setTimeout(() => res.socket?.destroy(), 50));
        return;
      }
      const from = Number(range[1]);
      res.writeHead(206, { 'Content-Length': BODY.length - from, 'Content-Range': `bytes ${from}-${BODY.length - 1}/${BODY.length}` });
      res.end(BODY.subarray(from));
    });
    const file = dest();
    const progress: number[] = [];
    const retries: string[] = [];
    await download(url, file, (f) => progress.push(f), SHA, (why) => retries.push(why));
    expect(fs.readFileSync(file).equals(BODY)).toBe(true);
    expect(asked[0]).toBe('(whole)');
    expect(asked[1]).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(asked[1])![0])).toBeGreaterThan(0);
    expect(retries).toHaveLength(1);
    expect(progress.at(-1)).toBeGreaterThan(0.95);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  }, 20_000);

  it('says why it failed: the server’s answer, and that curl isn’t there', async () => {
    path$ = programs();
    const url = await serve((_req, res) => {
      res.statusCode = 404;
      res.end('no');
    });
    await expect(download(url, dest(), undefined, SHA)).rejects.toThrow(/HTTP 404 from 127\.0\.0\.1:\d+; then curl isn’t installed/);
  });
});

describe('what downloads leave behind', () => {
  it('is removed by the names of the downloads only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-dl-'));
    for (const f of ['m.tar.bz2', 'm.tar.bz2.part', 'vad.onnx.part', 'vad.onnx', 'yours.tar.bz2']) fs.writeFileSync(path.join(dir, f), 'x');
    removePartials(dir, ['m.tar.bz2', 'vad.onnx']);
    expect(fs.readdirSync(dir).sort()).toEqual(['vad.onnx', 'yours.tar.bz2']);
  });

  it('a computer without tar or bzip2 is told before a download starts', () => {
    expect(missingUnpackers(() => true)).toEqual([]);
    expect(missingUnpackers((cmd) => cmd !== 'bzip2')).toEqual(process.platform === 'win32' ? [] : ['bzip2']);
  });
});
