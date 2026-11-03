/**
 * The studio as one program (`npx @saywright/studio`): its interface's files, the dispatch of the studio's routes, and the
 * guards around them (this computer's names only, nothing outside the interface's folder). Also its downloads, and
 * opening a file in your editor.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractTarBz2 } from '../../server/download';
import { editorRoute } from '../../server/editor';
import { MODELS, VAD_SHA256, VAD_URL } from '../../server/speech/catalog';
import { SpeechService } from '../../server/speech/service';
import { dispatch, staticFiles } from '../../server/standalone';
import { programs, tempShop } from './helpers';

const client = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-client-'));
fs.mkdirSync(path.join(client, 'assets'));
fs.writeFileSync(path.join(client, 'index.html'), '<!doctype html><title>Saywright</title>');
const bundle = `console.log(${JSON.stringify('the studio '.repeat(200))})`;
fs.writeFileSync(path.join(client, 'assets', 'index-abc123.js'), bundle);
// As the build writes them: compressed copies beside the file.
fs.writeFileSync(path.join(client, 'assets', 'index-abc123.js.br'), zlib.brotliCompressSync(bundle));
fs.writeFileSync(path.join(client, 'assets', 'index-abc123.js.gz'), zlib.gzipSync(bundle));
fs.writeFileSync(path.join(client, 'favicon.svg'), '<svg/>');
fs.writeFileSync(path.join(path.dirname(client), 'secret.txt'), 'outside');

let server: http.Server;
let base = '';
const seen: string[] = [];
beforeAll(async () => {
  const api = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next();
    seen.push(req.url);
    res.end('api');
  };
  const broken = () => {
    throw new Error('thrown before any promise');
  };
  server = http.createServer(dispatch([['/', api], ['/saywright.js', (_req, res) => res.end('bridge')], ['/broken', broken], ['/', staticFiles(client)]]));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const get = async (p: string, init?: RequestInit) => {
  const res = await fetch(base + p, init);
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), csp: res.headers.get('content-security-policy'), body: await res.text() };
};

describe('the interface', () => {
  it('serves its page, with the interface’s own routes answered by the page too', async () => {
    for (const p of ['/', '/apps', '/settings/ai']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.body).toContain('<title>Saywright</title>');
      expect(r.cache).toBe('no-cache');
      expect(r.csp).toBe("frame-ancestors 'none'");
    }
  });

  it('asks for its page to run apart from the app in its frame (in Chromium, a process of its own)', async () => {
    expect((await fetch(`${base}/apps`)).headers.get('origin-agent-cluster')).toBe('?1');
  });

  it('serves built files with long caching, by type', async () => {
    const js = await get('/assets/index-abc123.js');
    expect([js.status, js.type, js.cache]).toEqual([200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
    const svg = await get('/favicon.svg');
    expect([svg.status, svg.type]).toEqual([200, 'image/svg+xml']);
  });

  it('sends the compressed copy a browser accepts, and the file itself to one that takes none', async () => {
    const as = async (encoding: string) => {
      const res = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'accept-encoding': encoding } });
      return { encoding: res.headers.get('content-encoding'), vary: res.headers.get('vary'), length: Number(res.headers.get('content-length')), body: await res.text() };
    };
    const br = await as('gzip, deflate, br');
    expect(br).toMatchObject({ encoding: 'br', vary: 'Accept-Encoding', body: bundle });
    expect(br.length).toBeLessThan(bundle.length / 5);
    expect(await as('gzip')).toMatchObject({ encoding: 'gzip', body: bundle });
    expect(await as('br;q=0, identity')).toMatchObject({ encoding: null, vary: 'Accept-Encoding', length: bundle.length, body: bundle });
  });

  it('answers names the file system refuses like any other missing file', async () => {
    expect((await get(`/assets/${'a'.repeat(300)}.js`)).status).toBe(404);
    expect((await get(`/${'a'.repeat(300)}`)).body).toContain('<title>Saywright</title>');
  });

  it('says not found for a missing file, rather than sending the page', async () => {
    expect((await get('/assets/gone.js')).status).toBe(404);
  });

  it('never reaches outside its folder', async () => {
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const r = await get(p);
      expect(r.body).not.toContain('outside');
    }
  });

  it('answers nothing but reads', async () => {
    expect((await get('/', { method: 'POST' })).status).toBe(404);
  });
});

describe('dispatch', () => {
  it('answers 500 when a route throws before it returns, and keeps serving', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await get('/broken')).status).toBe(500);
    error.mockRestore();
    expect((await get('/')).status).toBe(200);
  });

  it('offers each request to the routes in order, under their prefix only', async () => {
    expect((await get('/api/status')).body).toBe('api');
    expect(seen).toContain('/api/status');
    expect((await get('/saywright.js')).body).toBe('bridge');
    // A longer name is another file, not the route.
    expect((await get('/saywright.json')).status).toBe(404);
  });
});

describe('unpacking a downloaded archive', () => {
  const tar = (dir: string, out: string, args: string[]) => execFileSync('tar', ['-cjf', out, ...args], { cwd: dir });

  it('unpacks plain files and folders, and refuses links and paths that leave its folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-tar-'));
    fs.mkdirSync(path.join(dir, 'model'));
    fs.writeFileSync(path.join(dir, 'model', 'tokens.txt'), 'hello');
    tar(dir, 'good.tar.bz2', ['model']);
    fs.writeFileSync(path.join(dir, 'evil.txt'), 'x');
    // An entry named ../evil.txt: tar run from a folder inside, told to keep the “../” (-P), as GNU tar and bsdtar
    // (macOS, Windows) both are. Windows' bsdtar has no -s to rename entries with.
    fs.mkdirSync(path.join(dir, 'inner'));
    tar(path.join(dir, 'inner'), path.join('..', 'escape.tar.bz2'), ['-P', '../evil.txt']);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-models-'));
    await extractTarBz2(path.join(dir, 'good.tar.bz2'), dest);
    expect(fs.readFileSync(path.join(dest, 'model', 'tokens.txt'), 'utf8')).toBe('hello');
    // Windows makes symbolic links only with a privilege an account may not have: links are checked elsewhere.
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.join(dir, 'linked'));
      fs.symlinkSync('/etc/passwd', path.join(dir, 'linked', 'passwd'));
      tar(dir, 'link.tar.bz2', ['linked']);
      await expect(extractTarBz2(path.join(dir, 'link.tar.bz2'), dest)).rejects.toThrow(/links/);
      expect(fs.existsSync(path.join(dest, 'linked'))).toBe(false);
    }
    await expect(extractTarBz2(path.join(dir, 'escape.tar.bz2'), dest)).rejects.toThrow(/outside its folder/);
    expect(fs.existsSync(path.join(path.dirname(dest), 'evil.txt'))).toBe(false);
  });
});

describe('downloading speech models', () => {
  it('checks each download against its pinned SHA-256, and keeps nothing that differs', async () => {
    for (const m of MODELS) expect(m.sha256, m.id).toMatch(/^[0-9a-f]{64}$/);
    expect(VAD_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-speech-'));
    const asked: string[] = [];
    // A server that answers with something else than the model.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      asked.push(String(url));
      return new Response('not the model');
    });
    const speech = new SpeechService(root, '', () => undefined);
    try {
      // First the voice-activity model the models use, then the model's archive.
      await expect(speech.install('omnilingual-300m')).rejects.toThrow(/checksum differs/);
      expect(asked).toEqual([VAD_URL]);
      fs.writeFileSync(speech.vadPath, 'x');
      await expect(speech.install('omnilingual-300m')).rejects.toThrow(/checksum differs/);
      expect(asked[1]).toMatch(/\/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12\.tar\.bz2$/);
      expect(fs.readdirSync(root).filter((f) => !f.endsWith('.part'))).toEqual(['silero_vad.onnx']);
      expect(speech.status().models.find((m) => m.id === 'omnilingual-300m')).toMatchObject({ installed: false, error: expect.stringMatching(/checksum differs/) });
    } finally {
      fetch.mockRestore();
    }
  });
});

describe('opening a file in your editor', () => {
  const app = tempShop();
  const file = path.join(app.root, 'src/components/CouponField.tsx');
  let editorServer: http.Server;
  let at = '';
  const saved = { LAUNCH_EDITOR: process.env.LAUNCH_EDITOR, VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
  beforeAll(async () => {
    editorServer = http.createServer(dispatch([['/__open-in-editor', editorRoute(() => app)]]));
    await new Promise<void>((resolve) => editorServer.listen(0, '127.0.0.1', resolve));
    at = `http://127.0.0.1:${(editorServer.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new Promise<void>((resolve) => editorServer.close(() => resolve()));
  });
  const open = async (target: string, init: RequestInit = { method: 'POST' }) => {
    const res = await fetch(`${at}/__open-in-editor?file=${encodeURIComponent(target)}`, init);
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; code?: string } };
  };

  it.skipIf(process.platform === 'win32')('starts the editor at the file’s line and column, without a shell', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-editor-'));
    const said = path.join(dir, 'args.txt');
    // An editor whose name launch-editor doesn't know gets the file, line and column as they are.
    process.env.LAUNCH_EDITOR = path.join(dir, 'my editor');
    fs.writeFileSync(process.env.LAUNCH_EDITOR, `#!/bin/sh\nprintf '%s|' "$@" > "${said}"\n`, { mode: 0o755 });
    expect(await open(`${file}:45:9`)).toEqual({ status: 200, body: { ok: true, editor: 'my editor' } });
    await vi.waitFor(() => expect(fs.readFileSync(said, 'utf8')).toBe(`${file}|45|9|`));
  });

  it('answers the studio’s page only, and only for a file of the open app', async () => {
    process.env.LAUNCH_EDITOR = path.join(os.tmpdir(), 'never-started');
    expect((await open(`${file}:1:1`, { method: 'GET' })).status).toBe(405);
    expect((await open(`${file}:1:1`, { method: 'POST', headers: { Origin: 'http://localhost:3000' } })).status).toBe(403);
    expect(await open('/etc/passwd:1:1')).toMatchObject({ status: 400, body: { error: expect.stringMatching(/outside the project/) } });
    expect((await open(`${path.join(app.root, '.env')}:1:1`)).status).toBe(400);
    expect(await open(`${path.join(app.root, 'src/Gone.tsx')}:1:1`)).toMatchObject({ status: 404, body: { error: 'No such file: src/Gone.tsx' } });
  });

  it('says so when it finds no editor, instead of claiming it opened', async () => {
    delete process.env.LAUNCH_EDITOR;
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    // Nothing to list the running programs with, either.
    const path$ = programs();
    try {
      expect(await open(`${file}:45:9`)).toEqual({ status: 409, body: { error: 'Couldn’t find your code editor. Open it, or set LAUNCH_EDITOR to its command (such as code), and try again.', code: 'no-editor' } });
    } finally {
      path$.restore();
    }
    process.env.LAUNCH_EDITOR = path.join(os.tmpdir(), 'no-such-editor');
    expect(await open(`${file}:45:9`)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/^Couldn’t start no-such-editor \(no such command\)/) } });
  });
});
