/**
 * The Claude-written report, without calling Claude: what it is given (the
 * evidence pack), the shape it must answer in, and how the answer is checked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { EMPTY_COUNTS, type SessionMeta } from '../../shared/session';
import { analyze } from '../../server/sessions/analyze';
import { Finding, ModelReportWriter, ReportSchema, evidencePack, relatedCode, type AskJson } from '../../server/sessions/report';
import { Project } from '../../server/project';
import type { StoredEvent } from '../../server/sessions/store';
import { tempShop } from './helpers';

const T0 = 1_700_000_000_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-report-'));
fs.writeFileSync(path.join(root, 'package.json'), '{"name":"shop"}');
fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/lib/pricing.ts'), Array.from({ length: 40 }, (_, i) => (i === 31 ? '  const discount = round2((subtotal + shipping) * rate);' : `// line ${i + 1}`)).join('\n'));
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shots-'));
fs.writeFileSync(path.join(shotDir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

const meta: SessionMeta = { id: 'r', name: 'Coupon', appUrl: 'http://localhost:5174/', source: 'studio', lang: 'ar', startedAt: T0, endedAt: T0 + 30_000, status: 'processing', counts: { ...EMPTY_COUNTS }, audioSeconds: 10, video: null };
const total = { src: 'src/lib/pricing.ts:32:3', name: 'div', tag: 'div', role: null, label: 'Total $78.40', text: 'Total $78.40', rect: [0, 0, 10, 10] as [number, number, number, number] };
const events = [
  { seq: 1, t: T0 + 100, page: 'p', type: 'page', url: 'http://localhost:5174/#/checkout', title: 'Checkout', referrer: '', viewport: [1, 1, 1], ua: '', lang: 'en', reload: false },
  { seq: 2, t: T0 + 4000, page: 'p', type: 'hover', el: total, ms: 3000 },
] as unknown as StoredEvent[];
const transcript = [{ id: 1, start: T0 + 4200, end: T0 + 6000, text: 'الإجمالي غلط، المفروض يكون ثمانين دولار وثمانين سنت', lang: 'ar', model: 'm', ms: 1 }];
const analysis = analyze(meta, events, transcript, [{ name: 'a.jpg', t: T0 + 4300, reason: 'speech', w: 10, h: 10 }]);
const input = { meta, analysis, project: new Project(root, 'http://localhost:5174'), shotPath: (n: string) => path.join(shotDir, n), previous: null };

describe('what Claude is given', () => {
  const pack = evidencePack(input);
  it('has the narration with what was pointed at, the issues, the timeline and the code', () => {
    expect(pack.text).toContain('<narration');
    expect(pack.text).toMatch(/S1 \[00:04\].*Total \$78\.40.*الإجمالي غلط/);
    expect(pack.text).toContain('<issues');
    expect(pack.text).toContain('--- src/lib/pricing.ts');
    expect(pack.text).toContain('  32|   const discount = round2((subtotal + shipping) * rate);');
  });
  it('attaches the screenshots nearest the issues', () => {
    expect(pack.images.map((i) => i.id)).toEqual(['P1']);
  });
});

describe('the code behind a problem', () => {
  // The sample shop: the tester points at the total and says it is wrong. It shows in OrderSummary; it is worked out in pricing.ts.
  const shop = tempShop();
  const totalRow = { src: 'src/components/OrderSummary.tsx:24:9', name: 'SummaryRow', tag: 'div', role: null, label: 'Total $78.40', text: 'Total $78.40', rect: [0, 0, 10, 10] as [number, number, number, number], path: 'App › Checkout › OrderSummary › SummaryRow' };
  const said = analyze(
    { ...meta, lang: 'en' },
    [events[0], { seq: 2, t: T0 + 4000, page: 'p', type: 'hover', el: totalRow, ms: 3000 } as unknown as StoredEvent],
    [{ id: 1, start: T0 + 4200, end: T0 + 6000, text: 'The total looks wrong, this should show $80.80.', lang: 'en', model: 'm', ms: 1 }],
    [],
  );
  const pack = evidencePack({ ...input, meta: { ...meta, lang: 'en' }, analysis: said, project: shop });
  const related = pack.text.slice(pack.text.indexOf('<code where="what that code imports'));

  it('includes the module where the value is worked out, with its lines, after the code where it showed', () => {
    expect(pack.text.indexOf('<code where="the problems showed">')).toBeLessThan(pack.text.indexOf('<code where="what that code imports'));
    expect(related).toContain('--- src/lib/pricing.ts (imported by src/components/OrderSummary.tsx)');
    expect(related).toContain('  32|   const discount = round2((subtotal + shipping) * rate);');
    // The page that renders it, where the cart and the totals come from.
    expect(related).toContain('--- src/pages/Checkout.tsx (renders src/components/OrderSummary.tsx)');
  });

  it('ranks what computes the questioned value first, and leaves out code the problem isn’t about', () => {
    const files = relatedCode(shop, said, ['src/components/OrderSummary.tsx']).map((r) => r.file);
    expect(files[0]).toBe('src/lib/pricing.ts');
    expect(files).not.toContain('src/lib/money.ts');
  });

  it('stays small: a few files, a bounded number of lines', () => {
    const lines = related.split('\n').filter((l) => /^\s*\d+\| /.test(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(160);
    expect((related.match(/^--- /gm) ?? []).length).toBeLessThanOrEqual(4);
  });

  it('is left out when nothing was said to be wrong', () => {
    const quiet = analyze({ ...meta, lang: 'en' }, [events[0], { seq: 2, t: T0 + 4000, page: 'p', type: 'hover', el: totalRow, ms: 3000 } as unknown as StoredEvent], [], []);
    expect(evidencePack({ ...input, analysis: quiet, project: shop }).text).not.toContain('<code where="what that code imports');
  });

  it('gives Autopilot’s steps with what it saw, so a click that changed nothing isn’t taken for one that did nothing', () => {
    const run = analyze(
      { ...meta, source: 'autopilot', lang: 'en' },
      [events[0], { seq: 2, t: T0 + 3000, page: 'studio', type: 'autopilot', did: 'Clicked “Apply”', why: 'It said the code isn’t valid, which is expected for a code I made up.' } as unknown as StoredEvent],
      [],
      [],
    );
    expect(evidencePack({ ...input, analysis: run, project: shop }).text).toMatch(/command: Autopilot: Clicked “Apply” \(Autopilot: “It said the code isn’t valid, which is expected for a code I made up\.”\)/);
  });

  it('asks the writer for where it showed and for the cause', () => {
    const shape = Finding.shape;
    expect(shape.shown.description).toMatch(/Where it showed/);
    expect(shape.location.description).toMatch(/The cause/);
  });
});

describe('the answer', () => {
  it('has a schema the API accepts (every object closed, no unsupported constraints)', () => {
    const format = zodOutputFormat(ReportSchema) as unknown as { type: string; schema: Record<string, unknown> };
    expect(format.type).toBe('json_schema');
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.type === 'object') expect(o.additionalProperties).toBe(false);
      for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems']) expect(o[k]).toBeUndefined();
      Object.values(o).forEach(walk);
    };
    walk(format.schema);
  });

  it('is checked: evidence ids must exist, findings get ids, the language is kept', async () => {
    const parsed = {
      title: 'الخصم يُحسب على الشحن',
      summary: 'ملخص',
      verdict: 'fix-first',
      scoreNotes: { stability: 'a', usability: 'b', performance: 'c', accessibility: 'd' },
      findings: [{ category: 'bug', severity: 'high', title: 'الإجمالي غلط', what: 'w', expected: '$80.80', quote: transcript[0].text, evidence: ['S1', 'E99', 'I1'], shown: 'src/components/OrderSummary.tsx:24', location: 'src/lib/pricing.ts:32', fix: 'f', steps: ['a'], confidence: 'high' }],
      suggestions: [],
      positives: [],
      journey: [],
      nextSteps: [],
    };
    let request: Parameters<AskJson>[0] | null = null;
    const ask = (async (req: Parameters<AskJson>[0]) => {
      request = req;
      return { value: req.schema.parse(parsed), model: 'claude-opus-5-5' };
    }) as AskJson;
    const writer = new ModelReportWriter(ask, 'medium');
    const report = await writer.write(input);
    expect(report.lang).toBe('ar');
    expect(report.source).toBe('ai');
    expect(report.model).toBe('claude-opus-5-5');
    expect(report.findings[0].id).toBe('F1');
    expect(report.findings[0].evidence).toEqual(['S1', 'I1']);
    expect(report.findings[0]).toMatchObject({ shown: 'src/components/OrderSummary.tsx:24', location: 'src/lib/pricing.ts:32' });
    // Asked of the model for reports, in Arabic, with the screenshot attached.
    expect(request!.task).toBe('report');
    expect(request!.parts.some((p) => p.type === 'image')).toBe(true);
    const last = request!.parts.at(-1)!;
    expect(last.type === 'text' && last.text).toContain('Arabic');
  });

  it('never reads lighter than its findings: a high one means fix first, a critical one blocked', async () => {
    const answer = (verdict: string, severity: string) => ({
      title: 't',
      summary: 's',
      verdict,
      scoreNotes: { stability: 'a', usability: 'b', performance: 'c', accessibility: 'd' },
      findings: [{ category: 'bug', severity, title: 'x', what: 'w', expected: '', quote: '', evidence: [], shown: '', location: '', fix: 'f', steps: [], confidence: 'high' }],
      suggestions: [],
      positives: [],
      journey: [],
      nextSteps: [],
    });
    const verdictOf = async (verdict: string, severity: string) => (await new ModelReportWriter((async (req: Parameters<AskJson>[0]) => ({ value: req.schema.parse(answer(verdict, severity)), model: 'm' })) as AskJson).write(input)).verdict;
    expect(await verdictOf('ship', 'high')).toBe('fix-first');
    expect(await verdictOf('fix-first', 'critical')).toBe('blocked');
    expect(await verdictOf('ship', 'medium')).toBe('ship');
  });

  it('sets aside what the session didn’t show, as a test to add, and the verdict follows what it did show', async () => {
    const finding = (title: string, what: string, severity: string, evidence: string[] = ['I1']) => ({ category: 'bug', severity, title, what, expected: '', quote: '', evidence, shown: '', location: '', fix: 'f', steps: [], confidence: 'medium' });
    const answer = {
      title: 't',
      summary: 's',
      verdict: 'fix-first',
      scoreNotes: { stability: 'a', usability: 'b', performance: 'c', accessibility: 'd' },
      findings: [
        finding('Removing the third line crashes the cart', 'The handler throws for index 2. Not triggered in this session.', 'high', ['E99']),
        finding('Checkout may fail for some addresses', 'A 500 is possible for "Apt" addresses, though it never happened during the session.', 'high'),
        // What is missing on screen is a finding: “not shown”, or “not seen during the session”, is a problem seen.
        finding('The discount is not shown in the summary', 'After applying SAVE20 the discount row was not shown.', 'medium'),
        finding('No confirmation after saving', 'The “Saved” message was not seen during the session after Save.', 'medium'),
      ],
      suggestions: [],
      positives: [],
      journey: [],
      nextSteps: [],
    };
    const report = await new ModelReportWriter((async (req: Parameters<AskJson>[0]) => ({ value: req.schema.parse(answer), model: 'm' })) as AskJson).write(input);
    expect(report.findings.map((f) => f.title)).toEqual(['The discount is not shown in the summary', 'No confirmation after saving']);
    expect(report.findings[0].id).toBe('F1');
    expect(report.suggestions.map((x) => [x.kind, x.title])).toEqual([
      ['add', 'Removing the third line crashes the cart'],
      ['add', 'Checkout may fail for some addresses'],
    ]);
    expect(report.verdict).toBe('ship');
  });

  it('gives a finding without a place in the code where its evidence showed', async () => {
    const answer = {
      title: 't',
      summary: 's',
      verdict: 'fix-first',
      scoreNotes: { stability: 'a', usability: 'b', performance: 'c', accessibility: 'd' },
      findings: [{ category: 'bug', severity: 'high', title: 'Wrong total', what: 'w', expected: '20% of the $98.00 items is $19.60, so $83.40', quote: '', evidence: ['I1'], shown: '', location: '', fix: 'f', steps: [], confidence: 'medium' }],
      suggestions: [],
      positives: [],
      journey: [],
      nextSteps: [],
    };
    const report = await new ModelReportWriter((async (req: Parameters<AskJson>[0]) => ({ value: req.schema.parse(answer), model: 'm' })) as AskJson).write(input);
    expect(analysis.issues.find((g) => g.id === 'I1')?.src).toBe('src/lib/pricing.ts:32:3');
    expect(report.findings[0]).toMatchObject({ shown: 'src/lib/pricing.ts:32', location: 'src/lib/pricing.ts:32' });
  });

  it('passes on a failure, for the studio to write the report locally instead', async () => {
    const ask = (async () => {
      throw new Error('the answer was too long for the model’s limit');
    }) as AskJson;
    await expect(new ModelReportWriter(ask).write(input)).rejects.toThrow(/too long/);
  });

  it('translates with the light model, keeping ids', async () => {
    const report = { lang: 'en' as const, title: 'T', summary: 'S', verdict: 'fix-first' as const, scoreNotes: { stability: 'a', usability: 'b', performance: 'c', accessibility: 'd' }, findings: [], suggestions: [], positives: [], journey: [], nextSteps: [], source: 'ai' as const, at: 1 };
    let task = '';
    const ask = (async (req: Parameters<AskJson>[0]) => {
      task = req.task;
      return { value: req.schema.parse({ title: 'ت', summary: 'م', scoreNotes: report.scoreNotes, findings: [], suggestions: [], positives: [], journey: [], nextSteps: [] }), model: 'claude-haiku-5-5' };
    }) as AskJson;
    const out = await new ModelReportWriter(ask).translate({ ...report, model: 'claude-sonnet-5-5' }, 'ar');
    expect(task).toBe('light');
    expect(out.lang).toBe('ar');
    expect(out.title).toBe('ت');
    // Written by one model, translated by another: both are named.
    expect(out).toMatchObject({ model: 'claude-sonnet-5-5', translatedBy: 'claude-haiku-5-5' });
  });
});

describe('who wrote it', () => {
  it('names the model that wrote a report in the HTML export, or says it was written on this computer', async () => {
    const { localReport } = await import('../../server/sessions/report');
    const { renderHtml } = await import('../../server/sessions/export');
    const local = localReport(meta, analysis, undefined, 'en');
    expect(renderHtml(meta, analysis, local, new Map())).toContain('<footer>Saywright · Written on this computer (no AI)</footer>');
    const byAi = { ...local, source: 'ai' as const, model: 'acme-writer-2' };
    expect(renderHtml(meta, analysis, byAi, new Map())).toContain('<footer>Saywright · Written by acme-writer-2</footer>');
    // A translation names its translator too.
    expect(renderHtml(meta, analysis, { ...byAi, translatedFrom: 'ar', translatedBy: 'acme-light-1' }, new Map())).toContain('<footer>Saywright · Written by acme-writer-2, translated by acme-light-1</footer>');
  });
});

describe('the report in both languages', () => {
  it('is written on this computer in Arabic too, with the same findings', async () => {
    const { localReport } = await import('../../server/sessions/report');
    const en = localReport(meta, analysis, undefined, 'en');
    const ar = localReport(meta, analysis, undefined, 'ar');
    expect(ar.lang).toBe('ar');
    expect(ar.findings.map((f) => [f.id, f.severity, f.location, f.evidence.join()])).toEqual(en.findings.map((f) => [f.id, f.severity, f.location, f.evidence.join()]));
    // Every sentence the studio writes is Arabic (a quote stays as said, code and labels as they are).
    const arabic = /[؀-ۿ]/;
    for (const text of [ar.title, ar.summary, ...ar.positives, ...ar.nextSteps, ...ar.journey, ...ar.findings.flatMap((f) => [f.title, f.fix])]) expect(text).toMatch(arabic);
    expect(ar.summary).not.toMatch(/\b(clicks|inputs|spoken|testing)\b/);
    // Text from the app inside Arabic sentences is isolated, so it keeps its own direction, and every isolate is closed.
    for (const text of [ar.title, ar.summary, ...ar.nextSteps, ...ar.findings.flatMap((f) => [f.title, f.what])]) {
      expect((text.match(/\u2068/g) ?? []).length).toBe((text.match(/\u2069/g) ?? []).length);
    }
  });

  it('is translated by Claude keeping ids, evidence and code, and lines up by id', async () => {
    const { withTranslation, textOf, TranslationSchema } = await import('../../server/sessions/report');
    const original = {
      lang: 'ar' as const,
      title: 'الخصم يُحسب على الشحن',
      summary: 'ملخص',
      verdict: 'fix-first' as const,
      scoreNotes: { stability: 'a', usability: 'b', performance: 'c', accessibility: 'd' },
      findings: [
        { id: 'F1', category: 'bug' as const, severity: 'high' as const, title: 'الإجمالي غلط', what: 'w', expected: '$80.80', quote: 'الإجمالي غلط', evidence: ['S1'], location: 'src/lib/pricing.ts:32', fix: 'f', steps: ['a'], confidence: 'high' as const },
        { id: 'F2', category: 'usability' as const, severity: 'low' as const, title: 'ثانية', what: 'w2', expected: '', quote: '', evidence: ['E1'], location: '', fix: 'f2', steps: [], confidence: 'medium' as const },
      ],
      suggestions: [{ kind: 'fix' as const, title: 'اقتراح', why: 'لأن', effort: 'small' as const }],
      positives: ['جيد'],
      journey: ['فتح الدفع'],
      nextSteps: ['أصلح'],
      source: 'ai' as const,
      at: 1,
    };
    // What is sent: only the words, with the ids.
    const sent = textOf(original);
    expect(TranslationSchema.parse(sent)).toBeTruthy();
    expect(sent.findings.map((f) => f.id)).toEqual(['F1', 'F2']);
    // Claude answers in a different order: matched by id.
    const out = withTranslation(original, { ...sent, title: 'The discount includes shipping', findings: [{ ...sent.findings[1], title: 'Second' }, { ...sent.findings[0], title: 'The total is wrong', fix: 'Discount the subtotal only' }] }, 'en');
    expect(out.lang).toBe('en');
    expect(out.translatedFrom).toBe('ar');
    expect(out.findings.map((f) => [f.id, f.title, f.location, f.quote])).toEqual([
      ['F1', 'The total is wrong', 'src/lib/pricing.ts:32', 'الإجمالي غلط'],
      ['F2', 'Second', '', ''],
    ]);
  });

  it('asks for a translation with the same schema rules as the report', async () => {
    const { TranslationSchema } = await import('../../server/sessions/report');
    const format = zodOutputFormat(TranslationSchema) as unknown as { schema: Record<string, unknown> };
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.type === 'object') expect(o.additionalProperties).toBe(false);
      Object.values(o).forEach(walk);
    };
    walk(format.schema);
  });
});

describe('what the tester decided', () => {
  it('tells Claude which findings were set aside and which sentences were corrected', () => {
    const corrected = { ...analysis, transcript: analysis.transcript.map((s) => ({ ...s, text: 'الإجمالي غلط، المفروض ثمانين دولار', original: s.text })) };
    const pack = evidencePack({ ...input, analysis: corrected, dismissed: ['Small target: the “x” button is 20×20 px'] });
    expect(pack.text).toContain('<dismissed_by_tester>');
    expect(pack.text).toContain('Small target: the “x” button is 20×20 px');
    expect(pack.text).toContain('(corrected by the tester: exact)');
  });
});

describe('fixing several findings at once', () => {
  it('gives the agent the whole brief, after what was said', async () => {
    const { userMessage } = await import('../../server/ai/context');
    const msg = userMessage({ text: 'Fix these 2 problems found in a test session.', refs: [], mode: 'edit', brief: '1. [high] The total is wrong\n   Likely location: src/lib/pricing.ts:32\n\n2. [low] Small target' }, input.project);
    expect(msg).toContain('Said: "Fix these 2 problems found in a test session."');
    expect(msg).toContain('1. [high] The total is wrong');
    expect(msg).toContain('one propose_change with every edit');
  });
});
