/**
 * Test sessions on the server: storage (nothing lost, nothing doubled),
 * analysis (issues with evidence, narration linked to what was pointed at,
 * scores), the local report and the exported HTML.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent, SessionTarget } from '@saywright/vite/protocol';
import { EMPTY_COUNTS, type SessionMeta, type SessionReport, type TranscriptSegment } from '../../shared/session';
import { analyze, complaintSeverity, nameOf, pathOf, stackSource, withFindings } from '../../server/sessions/analyze';
import { renderHtml } from '../../server/sessions/export';
import { Sessions } from '../../server/sessions/index';
import { localReport, relSrc, reportLang } from '../../server/sessions/report';
import { SessionStore, type StoredEvent } from '../../server/sessions/store';
import { Project } from '../../server/project';
import type { SpeechService } from '../../server/speech/service';

const T0 = 1_700_000_000_000;

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return { id: 'x', name: 'Test', appUrl: 'http://localhost:5174/', source: 'studio', lang: 'auto', startedAt: T0, endedAt: T0 + 60_000, status: 'processing', counts: { ...EMPTY_COUNTS }, audioSeconds: 0, video: null, ...over };
}

const pay: SessionTarget = { src: 'src/components/OrderSummary.tsx:25:9', name: 'Button', tag: 'button', role: 'button', label: 'Pay $78.40', text: 'Pay $78.40', rect: [10, 10, 200, 40], locator: "page.getByRole('button', { name: 'Pay' })", description: 'the “Pay” button' };
const total: SessionTarget = { src: 'src/components/OrderSummary.tsx:18:7', name: 'SummaryRow', tag: 'div', role: null, label: 'Total $78.40', text: 'Total $78.40', rect: [10, 60, 300, 30] };

let seq = 0;
function ev(t: number, body: Record<string, unknown>): StoredEvent {
  return { seq: ++seq, t: T0 + t, page: 'p1', ...body } as unknown as StoredEvent;
}

function seg(id: number, start: number, end: number, text: string): TranscriptSegment {
  return { id, start: T0 + start, end: T0 + end, text, lang: /[؀-ۿ]/.test(text) ? 'ar' : 'en', model: 'test', ms: 10 };
}

describe('small targets (WCAG 2.5.8)', () => {
  const link = (spaced?: boolean): SessionTarget => ({ src: 'src/Nav.tsx:4:7', name: 'a', tag: 'a', role: 'link', label: 'Orders', text: 'Orders', rect: [10, 10, 64, 20], locator: "page.getByRole('link', { name: 'Orders' })", ...(spaced ? { spaced } : {}) });
  const issuesOf = (el: SessionTarget) => analyze(meta(), [ev(0, { type: 'page', url: 'http://localhost:5174/', title: 'Home', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false }), ev(1000, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el })], [], []).issues;
  it('are flagged when crowded, and pass when spaced so a 24 px circle on them reaches nothing else, as the Experts judge', () => {
    expect(issuesOf(link()).map((g) => g.title)).toContain('Small target: the “Orders” link is 64×20 px');
    expect(issuesOf(link(true)).filter((g) => g.kind === 'accessibility')).toEqual([]);
  });
});

describe('session analysis', () => {
  const events = [
    ev(0, { type: 'page', url: 'http://localhost:5174/#/checkout', title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false }),
    ev(1000, { type: 'input', el: { ...total, role: 'textbox', label: 'Coupon', locator: "page.getByLabel('Coupon')" }, value: 'SAVE20', masked: false }),
    ev(1500, { type: 'net', via: 'fetch', method: 'POST', url: '/api/coupon', status: 500, ok: false, ms: 120, body: 'boom' }),
    ev(1600, { type: 'net', via: 'fetch', method: 'POST', url: '/api/coupon', status: 500, ok: false, ms: 130 }),
    ev(2000, { type: 'error', kind: 'error', message: 'Cannot read properties of undefined', stack: 'TypeError: x\n    at apply (http://localhost:5174/src/lib/pricing.ts?t=1:32:11)\n    at node_modules/react-dom/x.js:1:1' }),
    ev(5000, { type: 'hover', el: total, ms: 4000 }),
    ev(9000, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: pay }),
    ev(9200, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 2, el: pay }),
    ev(9300, { type: 'rage', x: 1, y: 1, clicks: 3, el: pay }),
    ev(10_300, { type: 'dead', x: 1, y: 1, el: pay }),
    ev(12_000, { type: 'mark', note: 'total looks off', via: 'key' }),
  ];
  const transcript = [seg(1, 5200, 8000, 'الإجمالي غلط، المفروض يكون ثمانين دولار'), seg(2, 20_000, 22_000, 'Nice, the page looks clean.')];
  const shots = [{ name: `${T0 + 2400}-error.jpg`, t: T0 + 2400, reason: 'error', w: 100, h: 60 }];
  const a = analyze(meta(), events, transcript, shots);

  it('groups repeated problems and keeps the evidence', () => {
    const net = a.issues.find((g) => g.kind === 'network')!;
    expect(net.count).toBe(2);
    expect(net.severity).toBe('high');
    expect(net.evidence).toHaveLength(2);
    const ids = new Set(a.timeline.map((x) => x.id));
    for (const g of a.issues) for (const e of g.evidence) expect(ids.has(e)).toBe(true);
  });

  it('finds where an error was thrown in the app’s own code', () => {
    const err = a.issues.find((g) => g.kind === 'error')!;
    expect(err.src).toBe('src/lib/pricing.ts:32:11');
    expect(err.shot).toBe(shots[0].name);
  });

  it('links what was said to what was pointed at, and hears a complaint in Arabic', () => {
    const said = a.issues.find((g) => g.kind === 'said')!;
    expect(said.title).toContain('الإجمالي غلط');
    expect(said.el?.label).toBe('Total $78.40');
    expect(said.src).toBe(total.src);
    // A compliment is not an issue.
    expect(a.issues.filter((g) => g.kind === 'said')).toHaveLength(1);
  });

  it('counts frustration and gives readable ids in time order', () => {
    expect(a.issues.some((g) => g.kind === 'frustration' && g.title.startsWith('Rage clicks'))).toBe(true);
    expect(a.issues.some((g) => g.kind === 'frustration' && /does nothing/.test(g.title))).toBe(true);
    const times = a.timeline.map((x) => x.t);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(a.timeline.filter((x) => x.kind === 'speech').map((x) => x.id)).toEqual(['S1', 'S2']);
    expect(a.timeline.find((x) => x.kind === 'shot')?.id).toBe('P1');
  });

  it('scores the session, and never calls one with a serious problem good', () => {
    expect(a.scores.stability.score).toBeLessThan(70);
    expect(a.scores.usability.score).toBeLessThan(80);
    expect(a.scores.performance.score).toBe(100);
    expect(a.scores.overall).toBeLessThanOrEqual(79);
    const clean = analyze(meta(), [events[0]], [], []);
    expect(clean.scores.overall).toBe(100);
  });

  it('keeps the steps to replay it as a test', () => {
    expect(a.steps.map((s) => s.kind)).toEqual(['navigate', 'fill', 'click', 'click']);
  });

  it('writes a report without AI', () => {
    const r = localReport(meta(), a);
    expect(r.source).toBe('local');
    expect(r.verdict).toBe('fix-first');
    const said = r.findings.find((f) => f.title.includes('الإجمالي'))!;
    expect(said.quote).toBe(transcript[0].text);
    expect(said.location).toBe(total.src);
  });
});

describe('a session with nothing technical wrong', () => {
  // The SAVE20 coupon on the checkout, sent with Enter, then Pay: the total is wrong, but nothing errs or stalls.
  const field: SessionTarget = { src: 'src/components/CouponField.tsx:44:7', name: 'TextField', tag: 'input', role: 'textbox', label: 'Coupon', text: '', rect: [10, 10, 200, 40], locator: "page.getByTestId('coupon-input')", description: 'the “Coupon” field' };
  const events = [
    ev(0, { type: 'page', url: 'http://localhost:5174/#/checkout', title: 'Tidewell · Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false }),
    ev(3000, { type: 'input', el: field, value: 'SAVE20', masked: false }),
    ev(3500, { type: 'key', key: 'Enter', mods: '', el: field }),
    ev(3510, { type: 'submit', el: { src: 'src/components/CouponField.tsx:37:5', name: 'form', tag: 'form', role: null, label: 'Coupon', text: 'CouponApply', rect: [0, 0, 300, 60] } }),
    ev(9000, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: pay }),
  ];
  const a = analyze(meta(), events, [], []);
  const r = localReport(meta(), a);

  it('never claims more than a recording can show', () => {
    expect(r.findings).toEqual([]);
    expect(r.title).toBe('No technical problems found on Tidewell · Checkout');
    expect(r.summary).not.toMatch(/nothing went wrong/i);
    expect(r.summary).toContain('No errors, failed requests or signs of frustration were recorded.');
    expect(r.nextSteps[0]).toMatch(/^Add a check for each value that must be right/);
    const html = renderHtml(meta(), a, r, new Map());
    expect(html).toContain('No technical problems found');
    expect(html).toContain('can’t tell whether the values on screen are right');
    expect(html).not.toContain('Ready to ship');
  });

  it('says what the tester did, not only where', () => {
    expect(r.journey).toEqual(['Visited Tidewell · Checkout', 'Fill the “Coupon” field with “SAVE20”', 'Press Enter in the “Coupon” field', 'Click the “Pay” button']);
  });

  it('names a submitted form by its field', () => {
    expect(a.timeline.find((x) => x.text.startsWith('Submitted'))?.text).toBe('Submitted the “Coupon” form');
  });
});

describe('what the tester says', () => {
  it('hears a wrong total, an item missing from the cart and a task that can’t be finished as serious, in English and Arabic', () => {
    for (const said of [
      'The total looks wrong.',
      'Wait, the mug I just added is not in my cart.',
      'The price is incorrect here',
      "The discount doesn't add up",
      'I can’t check out',
      'It charged me twice',
      'الإجمالي غير صحيح',
      'الكوباية اللي ضفتها مش موجودة في السلة',
      'مش قادر ادفع',
      'الخصم خاطئ',
    ]) {
      expect(complaintSeverity(said), said).toBe('high');
    }
  });

  it('hears other complaints as medium', () => {
    for (const said of ["The confirmation doesn't show up", "The code didn't apply", 'That label is confusing', 'الزر مش واضح', 'لم يظهر الخصم', 'الرسالة مش موجودة']) {
      expect(complaintSeverity(said), said).toBe('medium');
    }
  });

  it('hears nothing wrong in plain narration', () => {
    for (const said of ['Let me look at the ceramics first.', 'I will add the mug to my cart.', 'The total looks right.', 'Now the checkout.', '20% off the items, nice.', 'خليني أشوف المنتجات الأول', 'تمام، هدفع دلوقتي']) {
      expect(complaintSeverity(said), said).toBeNull();
    }
  });
});

describe('scores next to a written report', () => {
  it('are held below “good” by a high finding the recording alone couldn’t see', async () => {
    const quiet = analyze(meta(), [], [], []);
    expect(quiet.scores.overall).toBe(100);
    expect(withFindings(quiet.scores, [{ severity: 'high' }]).overall).toBe(79);
    expect(withFindings(quiet.scores, [{ severity: 'critical' }, { severity: 'low' }]).overall).toBe(59);
    expect(withFindings(quiet.scores, [{ severity: 'medium' }])).toBe(quiet.scores);

    // A session where nothing technical went wrong, and the report finds the total wrong.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-capped-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"t"}');
    const report: SessionReport = { lang: 'en', title: 'The total is wrong', summary: 's', verdict: 'fix-first', scoreNotes: { stability: '', usability: '', performance: '', accessibility: '' }, findings: [{ id: 'F1', category: 'bug', severity: 'high', title: 'SAVE20 discounts shipping', what: 'w', expected: '', quote: '', evidence: [], location: 'src/lib/pricing.ts:32', fix: 'f', steps: [], confidence: 'high' }], suggestions: [], positives: [], journey: [], nextSteps: [], source: 'ai', model: 'm', at: Date.now() };
    const sessions = new Sessions({ project: new Project(root, 'http://localhost:1'), speech: { canNarrate: () => false } as unknown as SpeechService, emit: () => undefined, writer: () => ({ write: async () => report }) });
    const m = sessions.start({ appUrl: 'http://localhost:1', source: 'studio', lang: 'en' });
    sessions.stop(m.id);
    for (let i = 0; i < 100 && sessions.store.meta(m.id).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sessions.detail(m.id).analysis?.scores.overall).toBe(79);
    expect(sessions.store.meta(m.id).report).toMatchObject({ overall: 79, scores: { overall: 79 } });
    sessions.close();
  });
});

describe('what the evidence means', () => {
  it('flags a data request answered with the app’s page (a missing API route)', () => {
    const a = analyze(meta(), [ev(0, { type: 'net', via: 'fetch', method: 'GET', url: '/api/orders', status: 200, ok: true, ms: 12, ctype: 'text/html' }), ev(10, { type: 'net', via: 'fetch', method: 'GET', url: '/about.html', status: 200, ok: true, ms: 5, ctype: 'text/html' })], [], []);
    const html = a.issues.filter((g) => g.kind === 'network');
    expect(html).toHaveLength(1);
    expect(html[0].title).toBe('GET /api/orders returns a web page instead of data');
  });

  it('counts every request and error the app’s page summarised, and says how many it had to drop', () => {
    const poll = { type: 'net', via: 'fetch', method: 'GET', status: 200, ok: true };
    const a = analyze(
      meta(),
      [
        ev(0, { ...poll, url: '/api/status?i=1', ms: 10 }),
        ev(5, { ...poll, url: '/api/status?i=2', ms: 20, repeat: 198 }),
        ev(10, { type: 'console', level: 'error', text: 'Render failed' }),
        ev(20, { type: 'console', level: 'error', text: 'Render failed', repeat: 4 }),
        ev(30, { type: 'dropped', count: 120, kinds: { trail: 100, console: 20 } }),
      ],
      [],
      [],
    );
    expect(a.network.total).toBe(200);
    expect(a.network.endpoints[0]).toMatchObject({ url: '/api/status', count: 200, avgMs: 20 });
    expect(a.issues.find((g) => g.kind === 'console')?.count).toBe(6);
    expect(a.summarised).toBe(202);
    expect(a.dropped).toBe(120);
  });

  it('does not call a click that threw an error “nothing happened”', () => {
    const a = analyze(meta(), [ev(0, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: pay }), ev(5, { type: 'error', kind: 'error', message: 'boom', stack: 'Error: boom\n    at onClick (src/App.tsx:3:1)' }), ev(0, { type: 'dead', x: 1, y: 1, el: pay })], [], []); // stamped with the click's time
    expect(a.issues.some((g) => /does nothing/.test(g.title))).toBe(false);
    expect(a.issues.some((g) => g.kind === 'error')).toBe(true);
  });
});

describe('waiting', () => {
  it('is normal: pauses, resting on something and the page being busy while nobody used it are not problems', () => {
    const a = analyze(meta({ endedAt: T0 + 120_000 }), [
      ev(0, { type: 'page', url: 'http://localhost:5174/#/checkout', title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false }),
      // From before the session started (an older recorder sent these).
      ev(-30_000, { type: 'perf', metric: 'longtask', value: 4500 }),
      ev(-30_000, { type: 'perf', metric: 'inp', value: 900, el: pay, detail: 'click' }),
      ev(-30_000, { type: 'perf', metric: 'cls', value: 0.3, el: total }),
      // Busy while the tester read the page, then a long rest on the total, then silence.
      ev(20_000, { type: 'perf', metric: 'longtask', value: 450 }),
      ev(40_000, { type: 'hover', el: total, ms: 30_000 }),
      ev(100_000, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: pay }),
    ], [seg(1, 60_000, 63_000, 'Let me read this for a second.')], []);
    expect(a.issues).toEqual([]);
    expect(a.scores.overall).toBe(100);
    expect(a.timeline.some((x) => x.kind === 'performance')).toBe(false);
    expect(a.perf).toMatchObject({ longTasks: 1, longTaskMs: 450, slowestInteraction: null, cls: 0 });
  });

  it('still finds an action that kept the tester waiting', () => {
    const a = analyze(meta(), [ev(1000, { type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: pay }), ev(1000, { type: 'perf', metric: 'inp', value: 650, el: pay, detail: 'pointerdown' })], [], []);
    expect(a.issues.map((g) => g.title)).toEqual(['Slow to respond after the “Pay” button (650 ms)']);
  });
});

describe('naming things', () => {
  it('names elements the way a person would', () => {
    expect(nameOf(pay)).toBe('the “Pay” button');
    expect(nameOf(total)).toBe('the “Total $78.40” SummaryRow');
    expect(nameOf({ ...total, name: 'div', path: 'Checkout › OrderSummary' })).toBe('the OrderSummary (“Total $78.40”)');
    expect(nameOf({ ...total, name: 'div', label: '', text: '' })).toBe('the OrderSummary');
    expect(nameOf(null)).toBe('the page');
  });
  it('keeps hash routes', () => {
    expect(pathOf('http://localhost:5174/#/checkout')).toBe('/#/checkout');
    expect(pathOf('http://localhost:5174/shop?q=1#top')).toBe('/shop?q=1');
  });
  it('finds the app frame in a stack trace', () => {
    expect(stackSource('at f (http://localhost:3000/_next/static/chunks/main.js:1:1)\n    at g (http://localhost:5174/src/App.tsx:4:2)')).toBe('src/App.tsx:4:2');
    expect(stackSource(undefined)).toBeNull();
    // After source maps: the project path the studio traced it to.
    expect(stackSource("TypeError: Cannot read properties of null (reading 'items')\n    at onClick (src/App.tsx:32:154)\n    at executeDispatch (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:9906:5)")).toBe('src/App.tsx:32:154');
    expect(stackSource('Error: x\n    at f (features/cart/Cart.tsx:3:9)')).toBe('features/cart/Cart.tsx:3:9');
  });
});

describe('report language', () => {
  it('follows what was said', () => {
    const a = analyze(meta(), [], [seg(1, 0, 1000, 'زرار الدفع مش شغال')], []);
    expect(reportLang(meta(), a)).toBe('ar');
    expect(reportLang(meta({ lang: 'en' }), a)).toBe('en');
  });
});

describe('session storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sess-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"t"}');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/App.tsx'), 'export const App = () => null;\n');
  const store = new SessionStore(new Project(root, 'http://localhost:1'));

  it('stores every event once, even when a batch is sent twice', () => {
    const m = store.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    const batch = { page: 'p', events: [1, 2, 3].map((n) => ({ seq: n, t: T0 + n, type: 'vis', hidden: false }) as SessionEvent) };
    expect(store.appendEvents(m.id, batch)).toHaveLength(3);
    expect(store.appendEvents(m.id, batch)).toHaveLength(0);
    expect(store.appendEvents(m.id, { page: 'q', events: batch.events })).toHaveLength(3);
    expect(store.events(m.id)).toHaveLength(6);
  });

  it('maps narration samples to wall-clock time across pauses, and ignores a resent chunk', () => {
    const m = store.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'ar' });
    const half = Buffer.alloc(16000); // 0.5 s
    store.appendAudio(m.id, T0, half);
    store.appendAudio(m.id, T0 + 10_000, half); // after a pause
    store.appendAudio(m.id, T0 + 10_000, half); // the same chunk again
    expect(store.meta(m.id).audioSeconds).toBe(1);
    expect(store.audioTime(m.id, 4000)).toBe(T0 + 250);
    expect(store.audioTime(m.id, 8000 + 4000)).toBe(T0 + 10_250);
    expect(store.audioWav(m.id)!.length).toBe(44 + 32000);
  });

  it('refuses additions after the session ends', () => {
    const m = store.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    store.update(m.id, { status: 'ready' });
    expect(() => store.appendEvents(m.id, { page: 'p', events: [] })).toThrow(/ended/);
  });

  it('still takes the app’s last events when they arrive just after Stop', () => {
    const m = store.create({ appUrl: 'http://localhost:1', source: 'app', lang: 'en' });
    store.update(m.id, { status: 'processing', endedAt: Date.now() });
    const late = { page: 'p', events: [{ seq: 1, t: T0, type: 'vis', hidden: false } as SessionEvent] };
    expect(store.appendEvents(m.id, late)).toHaveLength(1);
    expect(() => store.appendAudio(m.id, T0, Buffer.alloc(320))).toThrow(/ended/);
  });

  it('finds source files whatever form the browser reported them in', () => {
    const p = new Project(root, 'http://localhost:1');
    expect(relSrc(p, 'src/App.tsx:1:1')).toEqual({ file: 'src/App.tsx', line: 1 });
    expect(relSrc(p, `${root}/src/App.tsx:1:1`)).toEqual({ file: 'src/App.tsx', line: 1 });
    expect(relSrc(p, 'http://localhost:5174/src/App.tsx:1:2')).toEqual({ file: 'src/App.tsx', line: 1 });
    expect(relSrc(p, 'src/Missing.tsx:1:1')).toBeNull();
  });
});

describe('exported report', () => {
  it('is one self-contained page that reads right to left in Arabic', () => {
    const a = analyze(meta(), [], [seg(1, 0, 1000, 'الصفحة بطيئة جدا')], []);
    const r = { ...localReport(meta(), a), lang: 'ar' as const, title: 'تقرير <الجلسة>' };
    const html = renderHtml(meta(), a, r, new Map());
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('تقرير &lt;الجلسة&gt;');
    expect(html).not.toMatch(/<script/i);
  });
});
