/**
 * What arrives from the page during a session: uploads that never wait on the
 * speech engine, recordings that play with a length and can be scrubbed, one
 * file per screen share, and a server that only takes writes from this
 * computer's pages.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SessionClient } from '@saywright/vite/client';
import { durationWords, fmtDuration } from '../../shared/session';
import type { Workspace } from '../../server/apps/manager';
import { Router } from '../../server/http';
import { Project } from '../../server/project';
import { Sessions } from '../../server/sessions/index';
import { sessionRoutes } from '../../server/sessions/routes';
import { SessionStore } from '../../server/sessions/store';
import { restartWords } from '../../server/sessions/report';
import { finishWebm } from '../../server/sessions/webm';
import type { SpeechService } from '../../server/speech/service';

const FIXTURE = path.join(__dirname, '../fixtures/recording.webm');

function project(): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-capture-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"t"}');
  return new Project(root, 'http://localhost:1');
}

describe('screen recordings', () => {
  it('get a length written in, so the player can scrub (a real browser recording)', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-webm-')), 'v.webm');
    fs.copyFileSync(FIXTURE, file);
    const before = fs.readFileSync(file);
    // Recorded for about two seconds.
    const ms = await finishWebm(file);
    expect(ms).toBeGreaterThan(1500);
    expect(ms).toBeLessThan(2600);
    const after = fs.readFileSync(file);
    expect(after.includes(Buffer.from([0x44, 0x89, 0x88]))).toBe(true);
    // The frames are untouched: the file only gained the header field.
    expect(after.length - before.length).toBeLessThan(32);
    expect(after.subarray(after.length - 1000).equals(before.subarray(before.length - 1000))).toBe(true);
    // Done once only.
    expect(await finishWebm(file)).toBe(ms);
    expect(fs.readFileSync(file).length).toBe(after.length);
  });

  it('leaves anything else alone', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-webm-')), 'x.webm');
    fs.writeFileSync(file, 'not a video');
    expect(await finishWebm(file)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe('not a video');
    expect(await finishWebm(path.join(path.dirname(file), 'missing.webm'))).toBeNull();
  });

  it('keeps each share of the screen in its own file, and a resent piece once', () => {
    const store = new SessionStore(project());
    const m = store.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    const piece = (n: number) => Buffer.alloc(100, n);
    store.appendVideo(m.id, piece(1), { mime: 'video/webm', startedAt: 1000, n: 0 });
    store.appendVideo(m.id, piece(2), { mime: 'video/webm', startedAt: 1000, n: 1 });
    store.appendVideo(m.id, piece(2), { mime: 'video/webm', startedAt: 1000, n: 1 }); // a retry that already arrived
    // Shared again after a reload: a new recording.
    store.appendVideo(m.id, piece(3), { mime: 'video/webm', startedAt: 9000, n: 0 });
    const video = store.meta(m.id).video!;
    expect(video.parts?.map((p) => [p.file, p.startedAt, p.bytes])).toEqual([
      ['video.webm', 1000, 200],
      ['video-2.webm', 9000, 100],
    ]);
    expect(video.bytes).toBe(300);
    expect(fs.readFileSync(store.videoFile(m.id, 1)!).length).toBe(200);
    expect(fs.readFileSync(store.videoFile(m.id, 2)!)[0]).toBe(3);
    expect(store.videoFile(m.id, 3)).toBeNull();
    store.close();
  });
});

describe('narration uploads', () => {
  it('are stored at once and reach the recogniser in order once its model has loaded', async () => {
    const pushed: number[] = [];
    let loaded!: () => void;
    const modelLoad = new Promise<void>((r) => (loaded = r));
    const speech = {
      canNarrate: () => true,
      openStream: async () => {
        await modelLoad;
        return 'test-model';
      },
      push: (_sid: string, samples: Float32Array) => pushed.push(samples.length),
      close: async () => undefined,
      hasStream: () => true,
    } as unknown as SpeechService;
    const sessions = new Sessions({ project: project(), speech, emit: () => undefined, writer: () => null });
    const m = sessions.start({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    // The model is still loading: each upload returns right away, and nothing is lost.
    for (let i = 1; i <= 3; i++) sessions.audio(m.id, m.startedAt + i * 500, Buffer.alloc(i * 3200));
    expect(sessions.store.meta(m.id).audioSeconds).toBe(0.6);
    expect(sessions.store.audioChunks(m.id)).toHaveLength(3);
    expect(pushed).toEqual([]);
    loaded();
    await new Promise((r) => setTimeout(r, 10));
    expect(pushed).toEqual([1600, 3200, 4800]);
    // Stopping waits for the recogniser, then writes the report.
    const pressed = Date.now();
    expect(sessions.stop(m.id, pressed).endedAt).toBe(pressed);
    for (let i = 0; i < 50 && sessions.store.meta(m.id).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sessions.store.meta(m.id).status).toBe('ready');
    sessions.close();
  });

  it('take over a recording left behind by a closed tab, ending it when it went quiet', () => {
    const speech = { canNarrate: () => false } as unknown as SpeechService;
    const sessions = new Sessions({ project: project(), speech, emit: () => undefined, writer: () => null });
    const first = sessions.start({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    expect(() => sessions.start({ appUrl: 'http://localhost:1', source: 'studio', lang: 'en' })).toThrow(/Another session is recording/);
    const second = sessions.start({ appUrl: 'http://localhost:1', source: 'studio', lang: 'en', replace: true });
    expect(second.id).not.toBe(first.id);
    expect(sessions.store.meta(first.id).status).not.toBe('recording');
    sessions.close();
  });
});

describe('a studio that restarts while it records', () => {
  const speech = { canNarrate: () => false } as unknown as SpeechService;
  const deps = (p: Project) => ({ project: p, speech, emit: () => undefined, writer: () => null });

  it('takes the recording page’s writes again: the recording goes on, and its report says the studio restarted', () => {
    const p = project();
    const before = new Sessions(deps(p));
    const meta = before.start({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    const key = before.key(meta.id)!;
    // The key is kept beside it, for its owner only.
    const file = path.join(before.store.dir(meta.id), '.key');
    expect(fs.readFileSync(file, 'utf8')).toBe(key);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    before.store.close();

    // The studio comes back: the page, which kept what it recorded meanwhile, is let in with the key it holds.
    const after = new Sessions(deps(p));
    expect(after.key(meta.id)).toBe(key);
    expect(after.store.meta(meta.id).status).toBe('recording');
    expect(after.store.meta(meta.id).restarts).toEqual([{ at: expect.any(Number), resumed: false }]);
    after.resumed(meta.id);
    expect(after.store.meta(meta.id).restarts?.[0].resumed).toBe(true);
    after.stop(meta.id);
    // Ended: nothing more can be written to it after another restart.
    expect(fs.existsSync(file)).toBe(false);
    after.close();
  });

  it('finishes a recording whose page never comes back, with what it had', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = project();
      const before = new Sessions(deps(p));
      const meta = before.start({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
      before.store.close();
      const after = new Sessions(deps(p));
      expect(after.store.meta(meta.id).status).toBe('recording');
      vi.advanceTimersByTime(61_000);
      expect(after.store.meta(meta.id).status).not.toBe('recording');
      expect(after.store.meta(meta.id).restarts?.[0].resumed).toBe(false);
      after.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a page that reloads meanwhile finds the recording, though its app isn’t open in the studio yet', async () => {
    const p = project();
    const restored = new Sessions(deps(p));
    const meta = restored.start({ appUrl: 'http://localhost:3000', source: 'app', lang: 'en' });
    const ws = { project: p, sessions: restored, env: { url: 'http://localhost:3000/' }, frameUrl: 'http://localhost:3000/' } as unknown as Workspace;
    const router = new Router();
    sessionRoutes(router, { active: () => null, forSession: () => ws, recording: () => ws, speech, saveSpeechChoice: () => undefined, live: () => undefined });
    const mw = router.middleware('/api');
    const server = http.createServer((req, res) => void mw(req, res, () => res.writeHead(404).end()));
    const base = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
    try {
      const res = await fetch(`${base}/api/sessions/active`, { headers: { Origin: 'http://localhost:3000' } });
      const body = (await res.json()) as { session: { id: string } | null; key?: string };
      expect(body.session?.id).toBe(meta.id);
      // Only that it runs: the key stays with the page that holds it.
      expect(body.key).toBeUndefined();
    } finally {
      server.close();
      restored.close();
    }
  });

  it('a report says where the recording ended, in either language', () => {
    expect(restartWords({ resumed: false }).en).toMatch(/ended there/);
    expect(restartWords({ resumed: true }).en).toMatch(/nothing is missing/);
    expect(restartWords({ resumed: true }).ar).toMatch(/فلم يضع شيء/);
  });
});

describe('the studio server', () => {
  const router = new Router();
  router.post('/write', () => ({ ok: true }), { cors: true });
  router.post('/bytes', (req) => ({ length: (req.body as Buffer).length, binary: Buffer.isBuffer(req.body) }), { cors: true, bytes: true });
  router.post('/studio-only', () => ({ ok: true }));
  const mw = router.middleware('/api');
  const server = http.createServer((req, res) => void mw(req, res, () => res.writeHead(404).end()));
  const ready = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  afterAll(() => server.close());

  const post = async (route: string, origin: string | null, body: BodyInit = '{}') => {
    const base = await ready;
    const res = await fetch(`${base}/api${route}`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}) } });
    return { status: res.status, allow: res.headers.get('access-control-allow-origin'), body: await res.json() };
  };

  it('takes session writes from apps on this computer, and nothing from other websites', async () => {
    expect(await post('/write', 'http://localhost:3000')).toMatchObject({ status: 200, allow: 'http://localhost:3000' });
    expect(await post('/write', 'http://127.0.0.1:5174')).toMatchObject({ status: 200 });
    // A simple (text/plain) request skips the CORS preflight, so the server itself must refuse it.
    expect((await post('/write', 'https://evil.example')).status).toBe(403);
    expect((await post('/write', 'null')).status).toBe(403);
    // Tools and tests without an Origin (not a browser) are fine.
    expect((await post('/write', null)).status).toBe(200);
  });

  it('keeps studio-only routes to the studio itself', async () => {
    expect((await post('/studio-only', 'http://localhost:3000')).status).toBe(403);
    const base = await ready;
    expect((await post('/studio-only', base)).status).toBe(200);
  });

  it('reads byte routes as raw bytes whatever the declared type (no preflight, beacon-friendly)', async () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 0xd8]);
    expect((await post('/bytes', 'http://localhost:3000', bytes)).body).toEqual({ length: 6, binary: true });
  });
});

describe('taking over a recording', () => {
  const speech = { canNarrate: () => false } as unknown as SpeechService;
  const app = project();
  const sessions = new Sessions({ project: app, speech, emit: () => undefined, writer: () => null });
  // The app open in the studio, in its own tab at localhost:3000.
  const ws = { project: app, sessions, env: { url: 'http://localhost:3000/' }, frameUrl: 'http://localhost:3000/' } as unknown as Workspace;
  const router = new Router();
  sessionRoutes(router, { active: () => ws, forSession: () => ws, speech, saveSpeechChoice: () => undefined, live: () => undefined });
  const mw = router.middleware('/api');
  const server = http.createServer((req, res) => void mw(req, res, () => res.writeHead(404).end()));
  const ready = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  afterAll(() => {
    server.close();
    sessions.close();
  });

  /** Start a session from the studio's own page, or from another page on this computer (an app's own tab). */
  const start = async (from: string, body: Record<string, unknown>, key?: string) => {
    const base = await ready;
    const res = await fetch(`${base}/api/sessions${key ? `?k=${key}` : ''}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain', Origin: from === 'studio' ? base : from } });
    return { status: res.status, body: (await res.json()) as { session?: { id: string }; key?: string; error?: string; code?: string } };
  };
  const recording = (id: string) => sessions.store.meta(id).status === 'recording';

  it('another page can stop the recording only with its key, and isn’t offered to without it', async () => {
    const first = await start('studio', { source: 'studio' });
    const id = first.body.session!.id;
    expect((await start('http://localhost:3000', { source: 'app', replace: true })).status).toBe(403);
    expect(recording(id)).toBe(true);
    const busy = await start('http://localhost:3000', { source: 'app' });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/Another session is recording .*Stop it there first/);
    expect(busy.body.code).toBeUndefined();
    // The page that started it holds its key.
    const mine = await start('http://localhost:3000', { source: 'app', replace: true }, first.body.key);
    expect(mine.status).toBe(200);
    expect(recording(id)).toBe(false);
    expect(recording(mine.body.session!.id)).toBe(true);
  });

  it('a page of another site on this computer can’t start a session in the open app’s history', async () => {
    const before = sessions.store.list().length;
    const other = await start('http://localhost:7452', { source: 'app' });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/Only the app open in the studio/);
    expect(sessions.store.list().length).toBe(before);
    // Nor have the studio load its speech models.
    const base = await ready;
    const res = await fetch(`${base}/api/speech/warm`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain', Origin: 'http://localhost:7452' } });
    expect(res.status).toBe(403);
    // The open app is the same at any of this computer's names (here a session is recording already: it is told so).
    expect((await start('http://127.0.0.1:3000', { source: 'app' })).status).toBe(409);
  });

  it('the studio’s own page can take over any recording', async () => {
    const appId = sessions.active()!.id;
    const busy = await start('studio', { source: 'studio' });
    expect(busy).toMatchObject({ status: 409, body: { code: 'busy' } });
    const taken = await start('studio', { source: 'studio', replace: true });
    expect(taken.status).toBe(200);
    expect(recording(appId)).toBe(false);
    expect(sessions.active()?.id).toBe(taken.body.session!.id);
  });
});

describe('session lengths', () => {
  it('read naturally', () => {
    expect(fmtDuration(13_400)).toBe('13 s');
    expect(fmtDuration(185_000)).toBe('3 min');
    expect(fmtDuration(3_900_000)).toBe('1 h 05 min');
    expect(durationWords(1_000)).toBe('1 second');
    expect(durationWords(13_000)).toBe('13 seconds');
    expect(durationWords(60_000)).toBe('1 minute');
    expect(durationWords(3_600_000)).toBe('1 hour');
    expect(durationWords(3_900_000)).toBe('1 hour 5 minutes');
  });
});

describe('the voice indicator while recording', () => {
  const T = 1_800_000_000_000;
  /** A client recording with a microphone that last heard sound and speech at these times. */
  function client(mic: { startedAt?: number; lastSound?: number; lastVoice?: number }, state: Record<string, unknown> = {}) {
    const c = new SessionClient();
    Object.assign(c, { mic: { level: 0, startedAt: T, lastSound: 0, lastVoice: 0, ...mic } });
    c.state = { ...c.state, id: 's1', status: 'recording', mic: 'on', narration: 'live', ...state };
    return c;
  }

  it('says when the voice is heard, transcribed, and when nothing comes from the microphone', () => {
    // Speaking now.
    expect(client({ lastSound: T + 5000, lastVoice: T + 5000 }).voiceStatus(T + 5200).state).toBe('speaking');
    // Stopped talking: the sentence is being transcribed, then it came back.
    expect(client({ lastSound: T + 6000, lastVoice: T + 5000 }).voiceStatus(T + 6000).state).toBe('transcribing');
    expect(client({ lastSound: T + 7000, lastVoice: T + 5000 }, { heardAt: T + 6500 }).voiceStatus(T + 7000)).toMatchObject({ state: 'heard', text: 'Got it', tone: 'ok' });
    // Quiet, with the room's sound coming through.
    expect(client({ lastSound: T + 20_000, lastVoice: T + 5000 }, { heardAt: T + 6500 }).voiceStatus(T + 20_000).state).toBe('listening');
    // A muted microphone sends nothing at all.
    expect(client({ lastSound: 0 }).voiceStatus(T + 4000)).toMatchObject({ state: 'silent', tone: 'warn' });
    expect(client({ lastSound: T + 1000 }).voiceStatus(T + 5000).state).toBe('silent');
  });

  it('says when speech is recorded but not transcribed as it is said', () => {
    expect(client({ lastSound: T + 5000, lastVoice: T + 4000 }, { narration: 'loading' }).voiceStatus(T + 5000).state).toBe('loading');
    expect(client({ lastSound: T + 5000, lastVoice: T + 4000 }, { narration: 'off' }).voiceStatus(T + 5000)).toMatchObject({ state: 'untranscribed', tone: 'warn' });
    expect(client({}, { mic: 'denied' }).voiceStatus(T).state).toBe('blocked');
    expect(client({}, { mic: 'error' }).voiceStatus(T)).toMatchObject({ state: 'unavailable', text: 'No microphone' });
    expect(client({}, { mic: 'starting' }).voiceStatus(T).state).toBe('starting');
    expect(client({ lastSound: T + 5000 }, { paused: true }).voiceStatus(T + 5000).state).toBe('paused');
  });
});

describe('after a session: the report in both languages, corrections, rewriting', () => {
  it('writes the report, then its translation; a corrected sentence keeps what was heard and goes into the rewritten report', async () => {
    const live: { kind: string; id: string }[] = [];
    let finishTranslation!: () => void;
    const translated = new Promise<void>((r) => (finishTranslation = r));
    const written: string[][] = [];
    const writer = {
      write: async (input: { analysis: { transcript: { text: string }[] }; dismissed?: string[] }) => {
        written.push(input.analysis.transcript.map((s) => s.text));
        return { lang: 'en' as const, title: 'T', summary: 'S', verdict: 'ship' as const, scoreNotes: { stability: '', usability: '', performance: '', accessibility: '' }, findings: [{ id: 'F1', category: 'bug' as const, severity: 'high' as const, title: 'Wrong total', what: 'w', expected: '', quote: '', evidence: [], location: '', fix: 'f', steps: [], confidence: 'high' as const }], suggestions: [], positives: [], journey: [], nextSteps: [], source: 'claude' as const, at: Date.now() };
      },
      translate: async (r: import('../../shared/session').SessionReport, to: 'en' | 'ar') => {
        await translated;
        return { ...r, lang: to, translatedFrom: r.lang, title: 'عنوان' };
      },
    };
    const speech = { canNarrate: () => false } as unknown as SpeechService;
    const sessions = new Sessions({ project: project(), speech, emit: (_e, d) => live.push(d as { kind: string; id: string }), writer: () => writer as never });
    const m = sessions.start({ appUrl: 'http://localhost:1', source: 'studio', lang: 'en' });
    sessions.store.addSegment(m.id, { id: 1, start: m.startedAt + 1000, end: m.startedAt + 2000, text: 'the total is rong', lang: 'en', model: 't', ms: 1 });
    sessions.stop(m.id);
    for (let i = 0; i < 100 && sessions.store.meta(m.id).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    // Readable at once, translation still being written.
    expect(sessions.detail(m.id)).toMatchObject({ report: { lang: 'en' }, translation: null, translating: true });
    finishTranslation();
    for (let i = 0; i < 50 && sessions.detail(m.id).translating; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sessions.detail(m.id).translation).toMatchObject({ lang: 'ar', title: 'عنوان', translatedFrom: 'en' });
    expect(live.filter((e) => e.kind === 'report').length).toBeGreaterThanOrEqual(2);

    // Correct a word: the report's transcript shows it at once, the recogniser's words are kept.
    const seg = sessions.correct(m.id, 1, 'the total is wrong');
    expect(seg).toMatchObject({ text: 'the total is wrong', original: 'the total is rong' });
    expect(sessions.detail(m.id).analysis?.transcript[0]).toMatchObject({ text: 'the total is wrong', original: 'the total is rong' });
    expect(sessions.detail(m.id).analysis?.timeline.find((x) => x.kind === 'speech')?.text).toBe('the total is wrong');
    // Back to what was heard: no longer a correction.
    expect(sessions.correct(m.id, 1, 'the total is rong').original).toBeUndefined();
    sessions.correct(m.id, 1, 'the total is wrong');

    // Set a finding aside, then rewrite: Claude reads the corrected sentence and knows what was set aside.
    sessions.decide(m.id, { skipped: ['Wrong total'] });
    await sessions.process(m.id);
    expect(written.at(-1)).toEqual(['the total is wrong']);
    expect(sessions.detail(m.id).decisions.skipped).toEqual(['Wrong total']);
    sessions.close();
  });

  it('writes a local report in both languages at once', async () => {
    const speech = { canNarrate: () => false } as unknown as SpeechService;
    const sessions = new Sessions({ project: project(), speech, emit: () => undefined, writer: () => null });
    const m = sessions.start({ appUrl: 'http://localhost:1', source: 'studio', lang: 'ar' });
    sessions.stop(m.id);
    for (let i = 0; i < 100 && sessions.store.meta(m.id).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    const d = sessions.detail(m.id);
    expect(d.report?.lang).toBe('ar');
    expect(d.translation?.lang).toBe('en');
    expect(d.translating).toBe(false);
    sessions.close();
  });
});
