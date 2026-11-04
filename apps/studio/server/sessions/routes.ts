/**
 * HTTP routes for test sessions and local speech recognition. Routes the app
 * itself calls while recording (from its own tab or the studio's iframe) are
 * open to local origins; the rest are for the studio only.
 */
import { BRAND } from '../../shared/brand.ts';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { SessionBatch } from '@saywright/vite/protocol';
import type { ReplayOutcome, SessionLang, SessionMeta } from '../../shared/session.ts';
import { HttpError, type Req, type Router, asString, sameOrigin } from '../http.ts';
import type { Workspace } from '../apps/manager.ts';
import type { SpeechLang } from '../speech/catalog.ts';
import { toFloat, type SpeechService } from '../speech/service.ts';
import type { Sessions } from './index.ts';
import { exportHtml } from './export.ts';

interface Deps {
  /** The open app's workspace, or null when no app is open. */
  active: () => Workspace | null;
  /** The workspace a session belongs to (another app's, while its report is written). */
  forSession: (id: string) => Workspace;
  speech: SpeechService;
  saveSpeechChoice: (lang: SpeechLang, id: string | null) => void;
  /** Stream one session's live updates to a page. */
  live: (res: ServerResponse, id: string) => void;
}

const LANGS: SessionLang[] = ['en', 'ar', 'auto'];

function buffer(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) throw new HttpError(415, 'Send raw bytes with a binary Content-Type');
  return body;
}

function num(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? n : fallback;
}

/** The request carries the session's key (`?k=`), given to whoever started it. */
function holdsKey(req: Req, sessions: Sessions, id: string): boolean {
  const key = sessions.key(id);
  const given = req.query.get('k') ?? '';
  return !!key && given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key));
}

/** Stream a file, honouring Range requests so video can seek. Resolves when it has been sent. */
function sendFile(res: ServerResponse, file: string, type: string, range?: string): Promise<void> {
  const size = fs.statSync(file).size;
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (m && size > 0) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return Promise.resolve();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  // Headers go out now, so the router knows this response is taken.
  res.writeHead(status, headers);
  if (size === 0) {
    res.end();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => resolve());
    stream.pipe(res);
  });
}

/** This computer's own names: a page at 127.0.0.1:5173 is the app at localhost:5173. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Whether a page's origin is the address `url` is at (its scheme, port and name, any of this computer's names alike). */
function sameAddress(url: string, from: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(from);
    const port = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : '80');
    return a.protocol === b.protocol && port(a) === port(b) && (a.hostname === b.hostname || (LOOPBACK.test(a.hostname) && LOOPBACK.test(b.hostname)));
  } catch {
    return false;
  }
}

export function sessionRoutes(router: Router, deps: Deps): void {
  const { speech } = deps;
  const of = (id: string): Sessions => deps.forSession(id).sessions;
  const open = (): Workspace => {
    const ws = deps.active();
    if (!ws) throw new HttpError(409, 'Open an app first.', 'no-app');
    return ws;
  };
  const origin = (raw: { headers: Record<string, unknown> }) => String(raw.headers.host ? `http://${raw.headers.host}` : '');
  /**
   * Whether a page may start recording into the open app's sessions, or make the studio load its speech models: the
   * studio's own page, or the open app's (at its own address, or the proxy's in front of it). Any other page on this
   * computer could otherwise fill the app's history with what it likes, and have it reported on.
   */
  const fromOpenApp = (raw: Req['raw']): boolean => {
    if (sameOrigin(raw)) return true;
    const from = typeof raw.headers.origin === 'string' ? raw.headers.origin : '';
    // Not a browser (a tool, a test): as the router has it.
    if (!from) return true;
    const ws = deps.active();
    return !!ws && [ws.env?.url, ws.frameUrl].some((url) => !!url && sameAddress(url, from));
  };
  /**
   * Writing to a session (or following it) from an app's page takes the session's key, given to whoever started it:
   * another page on this computer can't add to or read someone else's recording. The studio's own page needs none.
   */
  const writer = (req: Req): void => {
    const sessions = of(req.params.id);
    if (!sameOrigin(req.raw) && !holdsKey(req, sessions, req.params.id)) throw new HttpError(403, 'This page can’t write to that session.');
    // After a restart, a recording goes on once its page is heard from again.
    sessions.resumed(req.params.id);
  };

  // ---- recording ----
  router.post(
    '/sessions',
    (req) => {
      if (!fromOpenApp(req.raw)) throw new HttpError(403, 'Only the app open in the studio can record a session. Open this app in the studio first.');
      const body = (req.body ?? {}) as { name?: string; appUrl?: string; source?: string; lang?: string; replace?: boolean; replayOf?: string };
      const lang = LANGS.includes(body.lang as SessionLang) ? (body.lang as SessionLang) : 'auto';
      const replayOf = body.source === 'replay' && typeof body.replayOf === 'string' ? body.replayOf : undefined;
      const ws = open();
      const sessions = ws.sessions;
      if (replayOf) sessions.store.meta(replayOf); // the session it replays must exist
      // Taking over stops the session that is recording: the studio's own page may, another page only with its key.
      const running = sessions.active();
      const mayStop = !running || sameOrigin(req.raw) || holdsKey(req, sessions, running.id);
      if (body.replace === true && !mayStop) throw new HttpError(403, 'Only the studio, or the page recording it, can stop the session that’s recording.');
      let meta: SessionMeta;
      try {
        meta = sessions.start({
          name: typeof body.name === 'string' ? body.name.slice(0, 120) : undefined,
          appUrl: typeof body.appUrl === 'string' ? body.appUrl.slice(0, 500) : ws.project.url,
          // Autopilot runs from the studio itself, never from an app's page.
          source: replayOf ? 'replay' : body.source === 'app' ? 'app' : body.source === 'autopilot' && sameOrigin(req.raw) ? 'autopilot' : 'studio',
          replayOf,
          lang,
          replace: body.replace === true,
        });
      } catch (err) {
        // A page that can't stop it isn't offered to (the 'busy' code brings the offer): it is told where to.
        if (err instanceof HttpError && err.code === 'busy' && !mayStop) throw new HttpError(409, `${err.message} Stop it there first.`);
        throw err;
      }
      return { session: meta, endpoint: origin(req.raw), key: sessions.key(meta.id) };
    },
    { cors: true },
  );

  // Replays are part of the session they check, not sessions of their own.
  router.get('/sessions', () => {
    const ws = deps.active();
    return { sessions: ws ? ws.sessions.store.list().filter((m) => m.source !== 'replay') : [], active: ws?.sessions.active() ?? null };
  });
  // An app's page learns only that a session is running (to pick it up after a reload, with the key it kept).
  router.get(
    '/sessions/active',
    (req) => {
      const ws = deps.active();
      const m = ws?.sessions.active() ?? null;
      if (!sameOrigin(req.raw)) return { session: m && { id: m.id, startedAt: m.startedAt, source: m.source, status: m.status }, endpoint: origin(req.raw) };
      // The studio (reloaded while recording) gives its frame the key again.
      return { session: m, endpoint: origin(req.raw), key: m ? ws!.sessions.key(m.id) : null };
    },
    { cors: true },
  );
  // A session's own live updates, for the recorder in an app's own tab.
  router.get(
    '/sessions/:id/live',
    (req, res) => {
      writer(req);
      deps.live(res, req.params.id);
    },
    { cors: true },
  );

  router.post(
    '/sessions/:id/events',
    (req) => {
      writer(req);
      const batch = req.body as SessionBatch;
      if (!batch || typeof batch !== 'object' || !Array.isArray(batch.events)) throw new HttpError(400, 'Expected { page, events }');
      return { ok: true, stored: of(req.params.id).events(req.params.id, batch) };
    },
    { cors: true },
  );

  router.post(
    '/sessions/:id/audio',
    (req) => {
      writer(req);
      of(req.params.id).audio(req.params.id, num(req.query.get('t'), Date.now()), buffer(req.body));
      return { ok: true };
    },
    { cors: true, bytes: true },
  );

  router.post(
    '/sessions/:id/shots',
    (req) => {
      writer(req);
      const jpeg = buffer(req.body);
      if (jpeg.length < 100 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, 'Expected a JPEG image');
      const shot = of(req.params.id).store.addShot(req.params.id, num(req.query.get('t'), Date.now()), req.query.get('reason') ?? 'moment', jpeg, { w: num(req.query.get('w'), 0), h: num(req.query.get('h'), 0) });
      return { shot };
    },
    { cors: true, bytes: true },
  );

  router.post(
    '/sessions/:id/video',
    (req) => {
      writer(req);
      const chunk = buffer(req.body);
      const mime = (req.query.get('mime') ?? 'video/webm').slice(0, 60);
      const n = req.query.get('n');
      of(req.params.id).store.appendVideo(req.params.id, chunk, { mime, startedAt: num(req.query.get('startedAt'), Date.now()), n: n === null ? undefined : num(n, 0) });
      return { ok: true };
    },
    { cors: true, bytes: true },
  );

  router.post(
    '/sessions/:id/mark',
    (req) => {
      writer(req);
      const body = (req.body ?? {}) as { note?: string; via?: string; t?: number };
      of(req.params.id).studioEvent(req.params.id, { type: 'mark', note: typeof body.note === 'string' ? body.note.slice(0, 300) : '', via: typeof body.via === 'string' ? body.via.slice(0, 20) : 'button', t: typeof body.t === 'number' ? body.t : Date.now() });
      return { ok: true };
    },
    { cors: true },
  );

  router.post('/sessions/:id/studio-events', (req) => {
    const body = (req.body ?? {}) as SessionBatch;
    if (!Array.isArray(body.events)) throw new HttpError(400, 'Expected { events }');
    return { ok: true, stored: of(req.params.id).events(req.params.id, { page: 'studio', events: body.events.slice(0, 500) }) };
  });

  router.post(
    '/sessions/:id/stop',
    (req) => {
      writer(req);
      return { session: of(req.params.id).stop(req.params.id, (req.body as { endedAt?: unknown } | undefined)?.endedAt) };
    },
    { cors: true },
  );

  // ---- results ----
  router.get('/sessions/:id', (req) => of(req.params.id).detail(req.params.id));

  router.put('/sessions/:id', (req) => {
    const name = asString((req.body as { name?: unknown } | undefined)?.name, 'name', 120).trim();
    if (!name) throw new HttpError(400, 'Name it something');
    return { session: of(req.params.id).store.update(req.params.id, { name }) };
  });

  router.delete('/sessions/:id', (req) => {
    of(req.params.id).remove(req.params.id);
    return { ok: true };
  });

  // A replay of this session's steps finished (in the studio): compare it with the session, once it is analysed.
  router.put('/sessions/:id/verify', (req) => {
    const body = (req.body ?? {}) as { replay?: unknown; outcome?: ReplayOutcome };
    const replay = typeof body.replay === 'string' ? body.replay : '';
    const o = body.outcome;
    if (!replay || !o || typeof o !== 'object' || !o.steps || !Array.isArray(o.checks)) throw new HttpError(400, 'Expected { replay, outcome }');
    const outcome: ReplayOutcome = {
      steps: {
        total: Math.max(0, Math.floor(Number(o.steps.total) || 0)),
        done: Math.max(0, Math.floor(Number(o.steps.done) || 0)),
        ...(o.steps.failed && typeof o.steps.failed === 'object'
          ? { failed: { i: Number(o.steps.failed.i) || 0, t: Number(o.steps.failed.t) || 0, description: String(o.steps.failed.description ?? '').slice(0, 200), descriptionAr: o.steps.failed.descriptionAr ? String(o.steps.failed.descriptionAr).slice(0, 200) : undefined, reason: String(o.steps.failed.reason ?? '').slice(0, 120) } }
          : {}),
      },
      checks: o.checks.slice(0, 50).map((c) => ({
        finding: typeof c.finding === 'string' ? c.finding.slice(0, 40) : undefined,
        issue: typeof c.issue === 'string' ? c.issue.slice(0, 40) : undefined,
        expected: String(c.expected ?? '').slice(0, 120),
        actual: c.actual == null ? null : String(c.actual).slice(0, 400),
        ok: c.ok === true,
      })),
    };
    of(req.params.id).verify(req.params.id, replay, outcome);
    return { ok: true };
  });

  /** Findings set aside: they leave the counts and “Fix all”, and a rewritten report doesn't raise them again. */
  router.put('/sessions/:id/decisions', (req) => {
    const skipped = (req.body as { skipped?: unknown } | undefined)?.skipped;
    if (!Array.isArray(skipped)) throw new HttpError(400, 'skipped: a list of finding titles');
    return { decisions: of(req.params.id).decide(req.params.id, { skipped: skipped.filter((x): x is string => typeof x === 'string') }) };
  });

  /** Correct what a sentence of the narration says (the recogniser's words are kept). */
  router.put('/sessions/:id/transcript/:seg', (req) => {
    const text = asString((req.body as { text?: unknown } | undefined)?.text, 'text', 2000);
    return { segment: of(req.params.id).correct(req.params.id, Math.floor(num(req.params.seg, -1)), text) };
  });

  /** Translate the report into the other language again (after a failure). */
  router.post('/sessions/:id/translate', (req) => {
    void of(req.params.id).translate(req.params.id);
    return { ok: true };
  });

  router.post('/sessions/:id/report', (req) => {
    const ai = (req.body as { ai?: boolean } | undefined)?.ai;
    const meta = of(req.params.id).store.meta(req.params.id);
    if (meta.status === 'recording') throw new HttpError(409, 'Stop the session first');
    of(req.params.id).store.update(req.params.id, { status: 'processing', stage: 'Finding issues' });
    void of(req.params.id).process(req.params.id, { ai: ai !== false }).catch((err) => {
      of(req.params.id).store.update(req.params.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    });
    return { session: of(req.params.id).store.meta(req.params.id) };
  });

  router.post('/sessions/:id/transcribe', (req) => {
    const lang = (req.body as { lang?: string } | undefined)?.lang;
    void of(req.params.id).retranscribe(req.params.id, LANGS.includes(lang as SessionLang) ? (lang as SessionLang) : undefined).catch((err) => {
      try {
        of(req.params.id).store.update(req.params.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      } catch {
        /* deleted */
      }
    });
    return { ok: true };
  });

  router.get('/sessions/:id/shots/:name', (req, res) => sendFile(res, of(req.params.id).store.shotFile(req.params.id, req.params.name), 'image/jpeg'));

  router.get('/sessions/:id/audio.wav', (_req, res) => {
    const wav = of(_req.params.id).store.audioWav(_req.params.id);
    if (!wav) throw new HttpError(404, 'No narration was recorded');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(wav.length));
    res.end(wav);
  });

  const sendVideo = (req: Req, res: ServerResponse, part: number) => {
    const file = of(req.params.id).store.videoFile(req.params.id, part);
    if (!file) throw new HttpError(404, 'No video was recorded');
    return sendFile(res, file, (of(req.params.id).store.meta(req.params.id).video?.mime ?? 'video/webm').split(';')[0], req.raw.headers.range);
  };
  router.get('/sessions/:id/video.webm', (req, res) => sendVideo(req, res, 1));
  // Later recordings in the same session (the screen was shared again).
  router.get('/sessions/:id/video/:part', (req, res) => sendVideo(req, res, Math.max(1, Math.floor(num(req.params.part, 1)))));

  router.get('/sessions/:id/export.html', (req, res) => {
    const html = exportHtml(of(req.params.id), req.params.id, req.query.get('lang'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.query.get('download')) res.setHeader('Content-Disposition', `attachment; filename="${BRAND.slug}-session-${req.params.id}.html"`);
    res.end(html);
  });

  // ---- speech ----
  router.get('/speech/status', () => speech.status());

  router.post('/speech/install', (req) => {
    const id = asString((req.body as { id?: unknown } | undefined)?.id, 'id', 80);
    void speech.install(id).catch(() => undefined);
    return speech.status();
  });

  router.put('/speech/choice', (req) => {
    const body = (req.body ?? {}) as { lang?: string; id?: string | null };
    if (body.lang !== 'ar' && body.lang !== 'en') throw new HttpError(400, 'lang must be ar or en');
    deps.saveSpeechChoice(body.lang, typeof body.id === 'string' ? body.id : null);
    return speech.status();
  });

  // ?lang=ar|en: the command model. ?mode=ar|en|auto: every model narration in that language uses.
  // Loading takes seconds: the answer comes at once, unless ?wait=1 (a recording counting down), which
  // answers once loaded with whether narration will be transcribed as it is said.
  router.post(
    '/speech/warm',
    async (req) => {
      if (!fromOpenApp(req.raw)) throw new HttpError(403, 'Only the app open in the studio can do that.');
      const mode = req.query.get('mode');
      if (mode) {
        const m = mode === 'en' ? 'en' : mode === 'ar' ? 'ar' : 'auto';
        const loading = speech.warmNarration(m);
        if (req.query.get('wait') !== '1') return { ok: true };
        return { ok: true, narration: (await loading) ? 'live' : 'off' };
      }
      void speech.warm(req.query.get('lang') === 'en' ? 'en' : 'ar');
      return { ok: true };
    },
    { cors: true },
  );

  /** A spoken command: 16 kHz 16-bit mono PCM in, text out. */
  router.post('/speech/transcribe', async (req) => {
    const pcm = buffer(req.body);
    const lang: SpeechLang = req.query.get('lang') === 'en' ? 'en' : 'ar';
    if (pcm.length < 3200) return { text: '', ms: 0, model: '' };
    if (!speech.available(lang)) throw new HttpError(409, `No ${lang === 'ar' ? 'Arabic' : 'English'} speech model installed`, 'no-model');
    return speech.transcribe(toFloat(pcm), lang, 'high');
  });

  router.get('/speech/test', async (req) => {
    // Lets `npm run doctor` check the engine end to end without a microphone.
    const lang: SpeechLang = req.query.get('lang') === 'en' ? 'en' : 'ar';
    if (!speech.available(lang)) throw new HttpError(409, 'No model installed', 'no-model');
    return speech.transcribe(new Float32Array(16000), lang, 'high');
  });
}
