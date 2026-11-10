/**
 * Long, noisy sessions: a failing poller, an error loop, a chatty console. Their report stays readable (one problem
 * with a count, not thousands), small (the lists are capped and say what they left out), and cheap to open later.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@saywright/vite/protocol';
import { EMPTY_COUNTS, type SessionMeta } from '../../shared/session';
import { analyze, analyzeAsync, ISSUES_PER_KIND, MAX_TIMELINE, normalizePath, normalizeText } from '../../server/sessions/analyze';
import { Sessions } from '../../server/sessions/index';
import { localReport } from '../../server/sessions/report';
import { SessionStore, type StoredEvent } from '../../server/sessions/store';
import { Project } from '../../server/project';
import type { SpeechService } from '../../server/speech/service';

const T0 = 1_700_000_000_000;
const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({ id: 'x', name: 'Long', appUrl: 'http://localhost:5174/', source: 'studio', lang: 'en', startedAt: T0, endedAt: T0 + 3_600_000, status: 'processing', counts: { ...EMPTY_COUNTS }, audioSeconds: 0, video: null, ...over });

let seq = 0;
const ev = (t: number, body: Record<string, unknown>): StoredEvent => ({ seq: ++seq, t: T0 + t, page: 'p1', ...body }) as unknown as StoredEvent;
const failed = (t: number, url: string, status = 500) => ev(t, { type: 'net', via: 'fetch', method: 'GET', url, status, ok: false, ms: 20, body: 'Internal error' });
const consoleError = (t: number, text: string) => ev(t, { type: 'console', level: 'error', text });

describe('what varies between repeats of one problem', () => {
  it('becomes a placeholder: numbers, ids, uuids and timestamps', () => {
    expect(normalizeText('Order 1234 failed at 2026-10-22T10:00:00.123Z (took 1500ms)')).toBe('Order {n} failed at {time} (took {n}ms)');
    expect(normalizeText('No user 3f2a9c1e-77b0-4d1c-9a51-0c5e8a6b2f10 in session 5f8d0a3b9c2e')).toBe('No user {id} in session {id}');
    expect(normalizeText('Retry at 1729591234567, attempt 3 of 5')).toBe('Retry at {time}, attempt {n} of {n}');
    // Names that carry digits stay as they are.
    expect(normalizeText("Cannot read properties of undefined (reading 'x11') in h1 at v2")).toBe("Cannot read properties of undefined (reading 'x11') in h1 at v2");
  });

  it('and record ids in an address: GET /api/orders/123 and /124 are one endpoint', () => {
    expect(normalizePath('/api/orders/123')).toBe('/api/orders/{id}');
    expect(normalizePath('/api/users/3f2a9c1e-77b0-4d1c-9a51-0c5e8a6b2f10/avatar')).toBe('/api/users/{id}/avatar');
    expect(normalizePath('/#/orders/42')).toBe('/#/orders/{id}');
    expect(normalizePath('/api/v2/items/V1StGXR8_Z5jdHi6B-myT9')).toBe('/api/v2/items/{id}');
    expect(normalizePath('/docs/getting-started')).toBe('/docs/getting-started');
  });
});

describe('a failing poller for an hour', () => {
  const events = Array.from({ length: 3000 }, (_, i) => failed(i * 1000, `http://localhost:5174/api/orders/${1000 + i}?poll=${i}`));
  const a = analyze(meta(), events, [], []);

  it('is one problem with a count, titled by its endpoint', () => {
    const net = a.issues.filter((g) => g.kind === 'network');
    expect(net).toHaveLength(1);
    expect(net[0].title).toBe('GET /api/orders/{id} returns 500');
    expect(net[0].count).toBe(3000);
    expect(a.network.endpoints).toEqual([expect.objectContaining({ method: 'GET', url: '/api/orders/{id}', count: 3000, failed: 3000 })]);
  });

  it('lists its first occurrences as evidence and counts the rest', () => {
    expect(a.timeline).toHaveLength(12);
    expect(a.issues[0].evidence).toHaveLength(12);
    expect(a.more?.timeline).toBe(2988);
    // The instance is kept in the moment itself.
    expect(a.timeline[0].text).toBe('GET /api/orders/1000?poll=0 failed (500) after 20 ms');
  });

  it('is reported as one issue', () => {
    expect(localReport(meta(), a).title).toBe('1 issue found: GET /api/orders/{id} returns 500');
  });
});

describe('an error loop with ids in its messages', () => {
  it('groups the messages, and keeps the exact wording when it never varied', () => {
    const a = analyze(meta(), [...Array.from({ length: 500 }, (_, i) => consoleError(i * 10, `Failed to load order ${i} at 2026-10-22T10:00:${String(i % 60).padStart(2, '0')}Z`)), consoleError(9000, 'Payment form crashed')], [], []);
    const con = a.issues.filter((g) => g.kind === 'console');
    expect(con.map((g) => [g.title, g.count])).toEqual([
      ['Console error: Failed to load order {n} at {time}', 500],
      ['Console error: Payment form crashed', 1],
    ]);
    // One example of the real text stays in the detail.
    expect(con[0].detail).toBe('Failed to load order 0 at 2026-10-22T10:00:00Z');
  });
});

describe('hundreds of different problems', () => {
  // Distinct wording, nothing to normalise: words built from letters.
  const word = (i: number) => Array.from(String(i).padStart(3, '0'), (d) => 'abcdefghij'[Number(d)]).join('');
  const events = Array.from({ length: 450 }, (_, i) => consoleError(i * 10, `Widget ${word(i)} is broken`));
  const a = analyze(meta(), events, [], []);

  it(`lists the first ${ISSUES_PER_KIND} of a kind and counts the rest`, () => {
    expect(a.issues.filter((g) => g.kind === 'console')).toHaveLength(ISSUES_PER_KIND);
    expect(a.more?.issues.console).toBe(250);
    // The moments of the ones not listed aren't listed either.
    expect(a.timeline).toHaveLength(ISSUES_PER_KIND);
    expect(a.more?.timeline).toBe(250);
    expect(localReport(meta(), a).title).toMatch(/^450 issues found: /);
  });

  it('keeps the scores readable: the biggest deductions by name, the rest in one line', () => {
    const notes = a.scores.stability.notes;
    expect(notes).toHaveLength(9);
    expect(notes[8]).toBe('−1768: 442 more problems like these');
    expect(a.scores.stability.notesAr?.[8]).toBe('−1768: 442 مشكلة أخرى مشابهة');
    expect(a.scores.stability.score).toBe(0);
  });
});

describe('a session with more moments than a timeline holds', () => {
  it('thins routine actions first, and keeps what was said and every problem’s evidence', () => {
    const el = { src: 'src/App.tsx:3:5', name: 'button', tag: 'button', role: 'button', label: 'Next', text: 'Next', rect: [0, 0, 80, 32], locator: "page.getByRole('button', { name: 'Next' })" };
    const clicks = Array.from({ length: MAX_TIMELINE + 2000 }, (_, i) => ev(i * 100, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el }));
    const said = { id: 1, start: T0 + 5000, end: T0 + 6000, text: 'This keeps loading', lang: 'en', model: 'test', ms: 5 };
    const a = analyze(meta(), [...clicks, failed(50, '/api/x')], [said], []);
    expect(a.timeline.length).toBe(MAX_TIMELINE);
    expect(a.more?.timeline).toBe(2002);
    expect(a.timeline.some((x) => x.kind === 'speech')).toBe(true);
    const net = a.issues.find((g) => g.kind === 'network')!;
    expect(net.evidence).toHaveLength(1);
    expect(a.timeline.some((x) => x.id === net.evidence[0])).toBe(true);
    // Replay still has every step.
    expect(a.steps.filter((s) => s.kind === 'click')).toHaveLength(MAX_TIMELINE + 2000);
  });
});

describe('analysing a long session', () => {
  it('gives the server a turn while it works, with the same result', async () => {
    const events = Array.from({ length: 20_000 }, (_, i) => (i % 4 ? failed(i * 5, `/api/items/${i}`, 404) : consoleError(i * 5, `Item ${i} missing`)));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const a = await analyzeAsync(meta(), events, [], []);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(a).toEqual(analyze(meta(), events, [], []));
    expect(a.issues.map((g) => [g.title, g.count])).toEqual([
      ['GET /api/items/{id} returns 404', 15_000],
      ['Console error: Item {n} missing', 5000],
    ]);
  });
});

describe('session storage for long sessions', () => {
  const app = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-long-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"long"}');
    return new Project(root, 'http://localhost:1');
  };

  it('streams events for analysis in time order, without the kinds it doesn’t read', async () => {
    const store = new SessionStore(app());
    const m = store.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    const batch = (page: string, events: Partial<SessionEvent>[]) => store.appendEvents(m.id, { page, events: events as SessionEvent[] });
    batch('a', [{ seq: 1, t: T0 + 30, type: 'trail', pts: [1, 2, 3] } as Partial<SessionEvent>, { seq: 2, t: T0 + 20, type: 'mark', note: 'two', via: 'key' } as Partial<SessionEvent>]);
    batch('b', [{ seq: 1, t: T0 + 10, type: 'mark', note: 'one', via: 'key' } as Partial<SessionEvent>, { seq: 2, t: T0 + 40, type: 'dom', reason: 'x', url: '/', title: '', headings: [], text: 'big' } as Partial<SessionEvent>]);
    fs.appendFileSync(path.join(store.dir(m.id), 'events.jsonl'), '{"seq":3,"t":17000000'); // cut short by a crash
    const events = await store.eventsForAnalysis(m.id);
    // The pointer's trail isn't read; what the screen said is (a report checks results against it).
    expect(events.map((e) => (e as { note?: string }).note ?? e.type)).toEqual(['one', 'two', 'dom']);
    store.close();
  });

  it('starts recording at once, and names the branch and commit a moment later', async () => {
    const project = app();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project.root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'start');
    const store = new SessionStore(project);
    const m = store.create({ appUrl: 'http://localhost:1', source: 'studio', lang: 'en' });
    expect(m.git).toBeNull();
    await vi.waitFor(() => expect(store.meta(m.id).git).toEqual({ branch: 'main', commit: expect.stringMatching(/^[0-9a-f]{7,}$/), dirty: true }));
    store.close();
  });

  it('takes no more than its size limit, whatever the page being recorded sends', () => {
    const project = app();
    const store = new SessionStore(project);
    store.maxBytes = 64 * 1024;
    const m = store.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    const piece = Buffer.alloc(24 * 1024, 1);
    const video = (n: number, to = store) => to.appendVideo(m.id, piece, { mime: 'video/webm', startedAt: T0, n });
    video(0);
    video(1);
    // Refused as “ended” (409), which the page's recorder takes as final instead of sending it again.
    const full = (() => {
      try {
        video(2);
      } catch (err) {
        return err as { status: number; code: string; message: string };
      }
    })();
    expect(full).toMatchObject({ status: 409, code: 'recording-full', message: 'This recording has reached its size limit (1 MB). Stop it to get its report.' });
    expect(fs.statSync(path.join(store.dir(m.id), 'video.webm')).size).toBe(2 * piece.length);
    // Every kind of thing a page sends counts toward it.
    expect(() => store.appendAudio(m.id, T0, Buffer.alloc(40 * 1024))).toThrow(/size limit/);
    expect(() => store.addShot(m.id, T0, 'moment', Buffer.alloc(40 * 1024), { w: 1, h: 1 })).toThrow(/size limit/);
    expect(() => store.appendEvents(m.id, { page: 'p', events: [{ seq: 1, t: T0, type: 'console', level: 'log', text: 'x'.repeat(40 * 1024) } as unknown as SessionEvent] })).toThrow(/size limit/);
    // What fits is still taken, and the session is still there to stop and report on.
    expect(store.appendEvents(m.id, { page: 'p', events: [{ seq: 2, t: T0, type: 'vis', hidden: false } as SessionEvent] })).toHaveLength(1);
    store.close();
    // After a restart what is on disk is counted again; a piece that was refused was never noted as written.
    const again = new SessionStore(project);
    again.maxBytes = 64 * 1024;
    expect(() => video(2, again)).toThrow(/size limit/);
    again.maxBytes = 1024 * 1024;
    video(2, again);
    expect(fs.statSync(path.join(again.dir(m.id), 'video.webm')).size).toBe(3 * piece.length);
    again.close();
  });

  it('after a restart, still drops a batch sent twice (reading what is stored only when a batch comes)', () => {
    const project = app();
    const first = new SessionStore(project);
    const m = first.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    const batch = { page: 'p', events: [1, 2].map((n) => ({ seq: n, t: T0 + n, type: 'vis', hidden: false }) as SessionEvent) };
    expect(first.appendEvents(m.id, batch)).toHaveLength(2);
    first.close();
    const again = new SessionStore(project);
    expect(again.meta(m.id).status).toBe('recording');
    expect(again.appendEvents(m.id, batch)).toHaveLength(0);
    again.close();
  });

  it('compares a report with the one before from its stored scores, without reading that one’s analysis', async () => {
    const speech = { canNarrate: () => false } as unknown as SpeechService;
    const sessions = new Sessions({ project: app(), speech, emit: () => undefined, writer: () => null });
    const older = sessions.store.create({ appUrl: 'http://localhost:1', source: 'studio', lang: 'en' });
    sessions.store.update(older.id, { status: 'ready', startedAt: T0, report: { source: 'local', at: T0, overall: 41, title: 'Older', scores: { overall: 41, stability: 10, usability: 90, performance: 80, accessibility: 100 } } });
    // A huge analysis that must not be read.
    fs.writeFileSync(path.join(sessions.store.dir(older.id), 'analysis.json'), '{"broken":');
    const newer = sessions.store.create({ appUrl: 'http://localhost:1', source: 'studio', lang: 'en' });
    const previous = sessions.previous(sessions.store.meta(newer.id));
    expect(previous?.id).toBe(older.id);
    expect(previous?.scores).toMatchObject({ overall: 41, stability: { score: 10 }, usability: { score: 90 }, performance: { score: 80 }, accessibility: { score: 100 } });
    sessions.close();
  });
});
