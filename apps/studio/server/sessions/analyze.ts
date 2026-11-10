/**
 * Turns a recorded session into findings without AI: a merged timeline,
 * grouped issues with evidence, and scores. Deterministic, so the same session
 * always scores the same.
 *
 * Long, noisy sessions stay readable: messages and addresses that differ only in
 * ids, numbers or timestamps are one problem with a count ("GET /api/orders/{id}"),
 * a problem's repeats past its evidence aren't listed one by one, and each kind of
 * problem lists its first 200; the rest is counted in `more`. The work is done in
 * slices (analyzeAsync), so the studio keeps answering while a long one runs.
 */
import { secretName, type SessionTarget } from '@saywright/vite/protocol';
import {
  AR_UNITS,
  arCount,
  type IssueKind,
  type ScoreBreakdown,
  type SessionAnalysis,
  type SessionIssue,
  type SessionMeta,
  type SessionScores,
  type SessionShot,
  type SessionStep,
  type Severity,
  type TimelineItem,
  type TranscriptSegment,
} from '../../shared/session.ts';
import { saidAt, saidValue } from '../../shared/expected.ts';
import { breathe } from '../slices.ts';
import { screenTexts, type Look } from './screens.ts';
import type { StoredEvent } from './store.ts';

const SLOW_REQUEST_MS = 1500;
/** Occurrences of one problem kept as its evidence (and listed in the timeline); later ones are counted. */
const EVIDENCE = 12;
/** Problems listed per kind; past these, how many more there are. */
export const ISSUES_PER_KIND = 200;
/** The timeline's length: past it, routine moments (and then repeats) are left out, and counted. */
export const MAX_TIMELINE = 5000;
/** Console warnings with the same wording listed in the timeline. */
const CONSOLE_REPEATS = 3;
/** Deductions listed by name under a score; the rest are summed in one line. */
const NOTES = 8;

/** Words that say something is wrong, in English and Arabic (MSA and Egyptian). */
const COMPLAINT_EN =
  /\b(wrong|incorrect|not right|isn['’]?t right|broken|bug|crash(es|ed)?|error|fail(s|ed|ing)?|doesn['’]?t work|does not work|not working|isn['’]?t working|(doesn['’]?t|does not|didn['’]?t|did not|won['’]?t|will not) (match|add up|show( up)?|load|save|update|change|appear|work|go through|apply|let me)|(is|are|was|were) not (in|there|showing|shown|updat(ed|ing)|saved|added|applied)|(isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t) (in|there|showing|shown|updat(ed|ing)|saved|added|applied)|not in (my|the|your) (cart|basket|bag|order|list)|can['’]?t (find|see|click|tell|figure)|cannot|confus(ed|ing)|slow|stuck|weird|strange|missing|lost (my|the|all)|off by|should (be|show|say|have)|expected|nothing happen(s|ed)|why (is|does|did|isn['’]?t)|hard to|too (small|big|slow|long)|ugly|annoying|unclear|where is|disappear(s|ed)?|no (feedback|message|error))\b/i;
const COMPLAINT_AR =
  /(غلط|خطأ|خطا|خاطئ|غير صحيح|مش صح|مو صح|مش مظبوط|مش مضبوط|مش شغال|مش بيشتغل|لا يعمل|ما بيشتغل|مبيشتغل|مشكله|مشكلة|بايظ|باظ|عطلان|بطيء|بطئ|بطيئ|تقيل|مش فاهم|مش واضح|غير واضح|مش لاقي|مالقيتش|ما لقيت|مش ظاهر|لا يظهر|لم يظهر|لم تظهر|ما ظهرش|مظهرش|اختفى|اختفي|مش موجود|مو موجود|غير موجود|ليس موجود|ناقص|مفقود|لم يتغير|لم تتغير|ما اتغيرش|متغيرش|لم يضف|لم تضف|لم يتم|ما اتضافش|متضافش|لا أستطيع|لا استطيع|مش قادر|مقدرش|المفروض|ليه|لماذا|ليش|مش راضي|مفيش|ما فيش|صعب|محير|مزعج|وحش|مكسور|كراش|ايرور|إيرور|ارور|bug|باج)/;
/** A complaint about money, a lost item, data or a task that can't be finished: the main task is wrong or broken. */
const SEVERE = new RegExp(
  [
    String.raw`crash|broken|data loss|lost (my|all|the) (data|work|changes|order|cart|items)`,
    String.raw`\b(total|subtotal|price|amount|sum|discount|tax|shipping|balance|charge|fee|cost|quantity|count)\b[^.?!]{0,30}\b(wrong|incorrect|not right|isn['’]?t right|doesn['’]?t (add up|match)|does not (add up|match))`,
    String.raw`\b(wrong|incorrect) (total|subtotal|price|amount|number|sum|discount|tax|shipping|charge|fee|quantity|count)`,
    String.raw`\b(not|isn['’]?t|aren['’]?t|wasn['’]?t) in (my|the|your) (cart|basket|bag|order)\b|missing from (my|the|your) (cart|basket|bag|order)`,
    String.raw`\b(can['’]?t|cannot) (pay|check ?out|log ?in|sign ?in|save|buy|place (an |my |the )?order)|\b(charged|charges) (me )?twice|double[- ]charged`,
    'غلط|مش شغال|لا يعمل|كراش|باظ|بايظ',
    '(الإجمالي|الاجمالي|المجموع|السعر|الأسعار|الاسعار|المبلغ|الخصم|الحساب|الشحن|الضريبة|الكمية)[^.؟!،]{0,25}(خطأ|خطا|خاطئ|غير صحيح|مش صح|مو صح|مش مظبوط|مش مضبوط)',
    '(مش|غير|مو|ليس|ليست|لا يوجد)[^.؟!،]{0,15}في (السلة|السله|سلتي|العربة|العربه|الطلب)',
    '(مش قادر|مش قادره|مش قادرة|لا أستطيع|لا استطيع|ما اقدر|ما أقدر|مقدرش)[^.؟!،]{0,10}(أدفع|ادفع|الدفع|أكمل|اكمل|أسجل|اسجل|أحفظ|احفظ|أشتري|اشتري|الشراء)',
  ].join('|'),
  'i',
);

/** How serious a sentence the tester said is: a complaint (medium), one about the main task (high), or neither. */
export function complaintSeverity(text: string): Severity | null {
  if (!COMPLAINT_EN.test(text) && !COMPLAINT_AR.test(text) && !SEVERE.test(text)) return null;
  return SEVERE.test(text) ? 'high' : 'medium';
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** The most serious of these. */
export function worstOf(severities: Severity[]): Severity | null {
  return severities.reduce<Severity | null>((w, s) => (w === null || RANK[s] < RANK[w] ? s : w), null);
}

/** The most the overall score can be with a problem this serious: a high one keeps it out of “good”, a critical one out of “fair”. */
function scoreCap(worst: Severity | null): number {
  return worst === 'critical' ? 59 : worst === 'high' ? 79 : 100;
}

/** The scores held down by the written report’s findings too: it can see a wrong total that a recording alone can’t. */
export function withFindings(scores: SessionScores, findings: { severity: Severity }[]): SessionScores {
  const overall = Math.min(scores.overall, scoreCap(worstOf(findings.map((f) => f.severity))));
  return overall === scores.overall ? scores : { ...scores, overall };
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * Text from the app (a label, a path, an error message) inside an Arabic
 * sentence: isolated, so its own direction is kept and its brackets and
 * slashes don't get reordered into the Arabic around it.
 */
function iso(text: string): string {
  return `⁨${text}⁩`;
}

/** Shortened text keeps every isolate it opened closed (see iso). */
export function balanced(text: string): string {
  const open = (text.match(/⁨/g) ?? []).length - (text.match(/⁩/g) ?? []).length;
  return open > 0 ? text + '⁩'.repeat(open) : text;
}

function fmtMsAr(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} ثانية` : `${Math.round(ms)} مللي ثانية`;
}

/** An address's parts, without building a URL for each of thousands of requests. */
const URL_PARTS = /^(?:[a-z][\w+.-]*:\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** The page part of a URL: path, a short query, and the hash when the app routes with it (#/checkout). */
export function pathOf(url: string): string {
  const m = /^(?:https?:\/\/[^/?#\s]+)?\/[^\s\\]*$/i.test(url) ? URL_PARTS.exec(url) : null;
  if (!m || /(^|\/)\.\.?(\/|$)|%/.test(m[1])) {
    // Anything unusual (relative steps, escapes, other schemes): as the browser would read it.
    try {
      const u = new URL(url, 'http://x');
      const hash = /^#!?\//.test(u.hash) ? u.hash : '';
      return u.pathname + (u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search) + hash;
    } catch {
      return url;
    }
  }
  const search = m[2] && m[2].length > 1 ? m[2] : '';
  const hash = m[3] && /^#!?\//.test(m[3]) ? m[3] : '';
  return (m[1] || '/') + (search.length > 40 ? search.slice(0, 40) + '…' : search) + hash;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * A message with what varies between occurrences of the same problem written as placeholders: timestamps {time},
 * uuids and hex ids {id}, other numbers {n}. "Order 1234 failed at 2026-10-22T10:00:00Z" → "Order {n} failed at {time}".
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '{time}')
    .replace(UUID, '{id}')
    .replace(/\b0x[0-9a-f]+\b/gi, '{id}')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '{id}')
    .replace(/(?<![\w.])1\d{9}(?:\d{3})?(?![\w.])/g, '{time}')
    .replace(/(?<![\w.{])\d+(?:[.,]\d+)*(?=(?:ms|s|px|kb|mb|%)?(?![\w}]))/gi, '{n}');
}

/** One part of an address that names a record rather than a place: a number, a uuid, a hex or random-looking id. */
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)[0-9a-f]{8,}|(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{20,})$/i;

/** A path with its record ids as {id}: "/api/orders/123/items" → "/api/orders/{id}/items". */
export function normalizePath(p: string): string {
  return p
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? '{id}' : seg))
    .join('/');
}

/** "the “Apply” button", falling back to the label or component name. */
export function nameOf(el: SessionTarget | null | undefined): string {
  if (!el) return 'the page';
  // The locator's description, unless it only had the source location to go on ("button at src/App.tsx:24:9").
  if (el.description && !/ at \S+:\d+:\d+$/.test(el.description)) return el.description;
  const label = (el.label || el.text).trim();
  const kind = el.role === 'button' ? 'button' : el.role === 'link' ? 'link' : el.role === 'textbox' ? 'field' : el.role === 'checkbox' ? 'checkbox' : el.name !== el.tag ? el.name : el.tag;
  // A plain container: name it by its component (from React's tree or the source file) rather than “div”.
  if (!el.role && /^(div|span|section|article|main|aside|li|ul|p|form|header|footer|nav|td|tr)$/.test(kind)) {
    const component = el.path?.split(' › ').pop() ?? el.src?.match(/([A-Za-z0-9_]+)\.[jt]sx?:/)?.[1];
    const short = label.length > 32 ? `${label.slice(0, 30)}…` : label;
    if (component) return short ? `the ${component} (“${short}”)` : `the ${component}`;
    return short ? `“${short}”` : 'an area of the page';
  }
  return label ? `the “${label.slice(0, 40)}” ${kind}` : kind;
}

/** The same, in Arabic: «زر «ادفع»», «حقل «القسيمة»», «المكوّن SummaryRow («الإجمالي…»)». */
function nameOfAr(el: SessionTarget | null | undefined): string {
  if (!el) return 'الصفحة';
  const label = (el.label || el.text).trim();
  const short = label.length > 40 ? `${label.slice(0, 38)}…` : label;
  const kind = el.role === 'button' ? 'زر' : el.role === 'link' ? 'رابط' : el.role === 'textbox' ? 'حقل' : el.role === 'checkbox' ? 'مربع الاختيار' : null;
  // One of several alike ("Add to cart" on every card): by its card, as the English says it.
  if (kind && el.within) return `${kind} «${iso(short)}» الخاص بـ «${iso(el.within)}»`;
  if (kind) return short ? `${kind} «${iso(short)}»` : kind;
  const tag = el.name !== el.tag ? el.name : el.tag;
  if (/^(div|span|section|article|main|aside|li|ul|p|form|header|footer|nav|td|tr)$/.test(tag)) {
    const component = el.path?.split(' › ').pop() ?? el.src?.match(/([A-Za-z0-9_]+)\.[jt]sx?:/)?.[1];
    const brief = short.length > 32 ? `${short.slice(0, 30)}…` : short;
    if (component) return brief ? `المكوّن ${iso(component)} («${iso(brief)}»)` : `المكوّن ${iso(component)}`;
    return brief ? `«${iso(brief)}»` : 'جزء من الصفحة';
  }
  return short ? `${iso(tag)} «${iso(short)}»` : iso(tag);
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

interface Deduction {
  points: number;
  note: string;
  noteAr?: string;
}

/** A score and why: the biggest deductions by name, the rest in one line (a noisy session can have hundreds). */
function score(deductions: Deduction[], cleanNote: string, cleanNoteAr: string): ScoreBreakdown {
  const total = deductions.reduce((a, d) => a + d.points, 0);
  if (!deductions.length) return { score: clamp(100), notes: [cleanNote], notesAr: [cleanNoteAr] };
  const sorted = deductions.sort((a, b) => b.points - a.points);
  const named = sorted.slice(0, NOTES);
  const rest = sorted.slice(NOTES);
  const restPoints = Math.round(rest.reduce((a, d) => a + d.points, 0));
  return {
    score: clamp(100 - total),
    notes: [...named.map((d) => `−${Math.round(d.points)}: ${d.note}`), ...(rest.length ? [`−${restPoints}: ${rest.length} more problems like these`] : [])],
    notesAr: [...named.map((d) => `−${Math.round(d.points)}: ${d.noteAr ?? d.note}`), ...(rest.length ? [`−${restPoints}: ${arCount(rest.length, AR_UNITS.issue)} أخرى مشابهة`] : [])],
  };
}

/** The first index in sorted `times` at or after `t`. */
function firstAtOrAfter(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The analysis of a session's events (in time order), its narration and screenshots. */
export function analyze(meta: SessionMeta, events: StoredEvent[], transcript: TranscriptSegment[], shots: SessionShot[]): SessionAnalysis {
  const run = analysis(meta, events, transcript, shots);
  for (;;) {
    const r = run.next();
    if (r.done) return r.value;
  }
}

/** The same, a slice at a time: the studio answers other requests while a long session is analysed. */
export async function analyzeAsync(meta: SessionMeta, events: StoredEvent[], transcript: TranscriptSegment[], shots: SessionShot[]): Promise<SessionAnalysis> {
  const run = analysis(meta, events, transcript, shots);
  for (;;) {
    const r = run.next();
    if (r.done) return r.value;
    await breathe();
  }
}

/** The analysis, pausing (yield) every few hundred events. */
function* analysis(meta: SessionMeta, events: StoredEvent[], transcript: TranscriptSegment[], shots: SessionShot[]): Generator<void, SessionAnalysis> {
  const start = meta.startedAt;
  let latest = start;
  for (const e of events) if (e.t > latest) latest = e.t;
  for (const s of transcript) if (s.end > latest) latest = s.end;
  const end = meta.endedAt ?? latest;
  const timeline: TimelineItem[] = [];
  const issues: SessionIssue[] = [];
  const steps: SessionStep[] = [];
  const fileRefs = new Map<string, number>();
  let omitted = 0;
  const refFile = (src: string | null | undefined, w = 1) => {
    const file = src?.replace(/:\d+:\d+$/, '');
    if (file && !/^https?:/.test(file)) fileRefs.set(file, (fileRefs.get(file) ?? 0) + w);
  };

  const add = (item: Omit<TimelineItem, 'id'>): TimelineItem => {
    const it: TimelineItem = { id: '', ...item };
    timeline.push(it);
    return it;
  };

  // ---- pages ----
  const pages: SessionAnalysis['pages'] = [];
  for (const e of events) {
    if (e.type === 'page' || e.type === 'nav') {
      const last = pages[pages.length - 1];
      if (last && last.url === e.url) continue;
      if (last) last.ms = e.t - last.t;
      pages.push({ url: e.url, title: e.title, t: e.t, ms: 0 });
    }
  }
  if (pages.length) pages[pages.length - 1].ms = end - pages[pages.length - 1].t;
  const startState = (events.find((e) => e.type === 'page' && !!(e as { state?: string }).state) as { state?: string } | undefined)?.state;

  // ---- grouping helpers ----
  const groups = new Map<string, SessionIssue>();
  const proof = new Map<SessionIssue, TimelineItem[]>();
  /** Problems written in words that vary (ids, numbers): their first wording, and their title once another differs. */
  const wording = new Map<SessionIssue, { first: string; varied: boolean; general: () => Pick<SessionIssue, 'title' | 'titleAr'> }>();
  type Wording = { text: string; general: () => Pick<SessionIssue, 'title' | 'titleAr'> };
  /** Group findings by key; each occurrence adds its timeline item as evidence (ids are given out at the end). */
  const issue = (key: string, make: () => Omit<SessionIssue, 'id' | 'count' | 'evidence'>, item: TimelineItem, words?: Wording): SessionIssue => {
    let g = groups.get(key);
    if (g) {
      g.count++;
      const items = proof.get(g)!;
      if (items.length < EVIDENCE) items.push(item);
      reword(g, words);
    } else {
      g = { id: `I${groups.size + 1}`, key, count: 1, evidence: [], ...make() };
      groups.set(key, g);
      issues.push(g);
      proof.set(g, [item]);
      if (words) wording.set(g, { first: words.text, varied: false, general: words.general });
    }
    item.issue = g.id;
    return g;
  };
  const reword = (g: SessionIssue, words?: Wording) => {
    const w = wording.get(g);
    if (w && words && !w.varied && words.text !== w.first) w.varied = true;
  };
  /**
   * One occurrence of a problem with its own moment in the timeline: listed while the problem has fewer than
   * EVIDENCE of them, then only counted (a failing poller isn't a thousand moments).
   */
  const occur = (key: string, item: () => Omit<TimelineItem, 'id'>, make: () => Omit<SessionIssue, 'id' | 'count' | 'evidence'>, words?: Wording): SessionIssue => {
    const g = groups.get(key);
    if (g && proof.get(g)!.length >= EVIDENCE) {
      g.count++;
      omitted++;
      reword(g, words);
      return g;
    }
    return issue(key, make, add(item()), words);
  };

  // ---- performance and network accumulators ----
  let fcp: number | null = null;
  let lcp: number | null = null;
  let cls = 0;
  let slowest: number | null = null;
  let longTasks = 0;
  let longTaskMs = 0;
  const endpoints = new Map<string, { method: string; url: string; count: number; failed: number; totalMs: number; statuses: Set<number> }>();
  let netTotal = 0;
  let netFailed = 0;
  let netSlow = 0;
  /** Events that stand for several (repeats counted by the app's page), and events the page had to drop. */
  let summarised = 0;
  let lost = 0;
  const disabledPresses = new Map<string, number>();
  const consoleSeen = new Map<string, number>();
  const errorTimes: number[] = [];
  for (const e of events) if (e.type === 'error') errorTimes.push(e.t);
  errorTimes.sort((a, b) => a - b);

  /** The screen's reads, and the last thing the tester did (what a read after an action followed). */
  const looks: Look[] = [];
  let lastAction: TimelineItem | null = null;

  let n = 0;
  for (const e of events) {
    if (++n % 500 === 0) yield;
    const at = e.t;
    if ((e.type === 'net' || e.type === 'error' || e.type === 'console') && e.repeat) summarised += e.repeat;
    switch (e.type) {
      case 'click': {
        const it = add({ t: at, kind: 'action', text: `${e.disabled ? 'Pressed disabled' : 'Clicked'} ${nameOf(e.el)}`, textAr: e.disabled ? `ضغط على ${nameOfAr(e.el)} وهو معطّل` : `نقر على ${nameOfAr(e.el)}`, src: e.el.src, detail: e.el.path });
        if (!e.disabled) lastAction = it;
        refFile(e.el.src);
        if (e.el.locator && !e.disabled) steps.push({ t: at, kind: 'click', locator: e.el.locator, description: `Click ${nameOf(e.el)}`, descriptionAr: `انقر على ${nameOfAr(e.el)}`, ...likeOf(e.el) });
        if (e.disabled) {
          const key = e.el.locator ?? e.el.src ?? e.el.label;
          const c = (disabledPresses.get(key) ?? 0) + 1;
          disabledPresses.set(key, c);
          if (c === 2)
            issue(`disabled:${key}`, () => ({ kind: 'frustration', severity: 'medium', title: `Kept pressing ${nameOf(e.el)} while it was disabled`, detail: 'Nothing said why it was disabled or what to do first.', titleAr: `ضغط مرارًا على ${nameOfAr(e.el)} وهو معطّل`, detailAr: 'لم يوضّح شيء سبب تعطيله ولا ما يجب فعله أولًا.', t: at, el: e.el, src: e.el.src }), it);
        }
        // Accessibility signals on what the user actually touched.
        if ((e.el.role === 'button' || e.el.role === 'link') && !e.el.label) {
          issue(`noname:${e.el.src ?? e.el.locator}`, () => ({ kind: 'accessibility', severity: 'medium', title: `${e.el.role === 'link' ? 'A link' : 'A button'} with no accessible name`, detail: 'Screen readers announce it as just “button”. Add text or an aria-label.', titleAr: `${e.el.role === 'link' ? 'رابط' : 'زر'} بلا اسم تقرؤه التقنيات المساعدة`, detailAr: 'قارئات الشاشة تنطقه «زر» فقط. أضف نصًا أو aria-label.', t: at, el: e.el, src: e.el.src }), it);
        }
        const [, , w, h] = e.el.rect;
        // Small but well spaced passes too (WCAG 2.5.8's spacing exception), as the Experts judge it.
        if (w > 0 && h > 0 && (w < 24 || h < 24) && !e.el.inline && !e.el.spaced && e.el.role && ['button', 'link', 'checkbox', 'radio'].includes(e.el.role)) {
          issue(`small:${e.el.src ?? e.el.locator}`, () => ({ kind: 'accessibility', severity: 'low', title: `Small target: ${nameOf(e.el)} is ${w}×${h} px`, detail: 'Touch and motor-impaired users need at least 24×24 px (WCAG 2.5.8).', titleAr: `هدف صغير: ${nameOfAr(e.el)} بحجم ${w}×${h} بكسل`, detailAr: 'مستخدمو اللمس وذوو الصعوبات الحركية يحتاجون 24×24 بكسل على الأقل (WCAG 2.5.8).', t: at, el: e.el, src: e.el.src }), it);
        }
        break;
      }
      case 'input': {
        const it = add({ t: at, kind: 'action', text: `Typed “${e.value.slice(0, 60)}” into ${nameOf(e.el)}`, textAr: `كتب «${iso(e.value.slice(0, 60))}» في ${nameOfAr(e.el)}`, src: e.el.src });
        lastAction = it;
        refFile(e.el.src);
        if (e.el.locator) {
          // A secret is a name to fill from (the Test tab, or SAYWRIGHT_SECRET_…), never a value: not in the steps, a test or a replay.
          const secret = e.masked ? { secret: e.secret ?? secretName(e.el.label || e.el.name) } : {};
          steps.push({ t: at, kind: 'fill', locator: e.el.locator, value: e.masked ? '' : e.value, ...secret, description: `Fill ${nameOf(e.el)}`, descriptionAr: `املأ ${nameOfAr(e.el)}`, ...likeOf(e.el) });
        }
        if (!e.el.label && e.el.role === 'textbox') {
          issue(`nolabel:${e.el.src ?? e.el.locator}`, () => ({ kind: 'accessibility', severity: 'medium', title: 'A field with no label', detail: 'Placeholder-only or unlabelled fields are hard to use with screen readers and once filled in.', titleAr: 'حقل بلا تسمية', detailAr: 'الحقول التي لا تحمل إلا نصًا توضيحيًا أو بلا تسمية صعبة الاستخدام مع قارئات الشاشة وبعد تعبئتها.', t: at, el: e.el, src: e.el.src }), it);
        }
        break;
      }
      case 'change': {
        lastAction = add({ t: at, kind: 'action', text: e.checked !== undefined ? `${e.checked ? 'Checked' : 'Unchecked'} ${nameOf(e.el)}` : `Chose “${e.value}” in ${nameOf(e.el)}`, textAr: e.checked !== undefined ? `${e.checked ? 'حدّد' : 'ألغى تحديد'} ${nameOfAr(e.el)}` : `اختار «${iso(e.value)}» في ${nameOfAr(e.el)}`, src: e.el.src });
        refFile(e.el.src);
        // A list's choice is a choice (every option chosen), not text to type: selectOption in a test.
        const list = e.checked === undefined && (e.el.tag === 'select' || e.el.role === 'combobox' || e.el.role === 'listbox');
        if (e.el.locator) steps.push({ t: at, kind: 'fill', locator: e.el.locator, value: e.value, ...(e.checked !== undefined ? { checked: e.checked } : {}), ...(list ? { select: e.options?.length ? e.options : [e.value] } : {}), ...(list && e.byValue && e.values?.length ? { values: e.values, byValue: true } : {}), description: `Set ${nameOf(e.el)}`, descriptionAr: `اضبط ${nameOfAr(e.el)}`, ...likeOf(e.el) });
        break;
      }
      case 'submit':
        // A form is named by its fields (the bridge's label); its locator text runs them together (“CouponApply”).
        lastAction = add({ t: at, kind: 'action', text: `Submitted ${e.el.label ? `the “${e.el.label.slice(0, 40)}” form` : nameOf(e.el)}`, textAr: `أرسل ${nameOfAr(e.el)}`, src: e.el.src });
        break;
      case 'key':
        if (e.key === 'Enter' || e.key === 'Escape' || e.mods) {
          lastAction = add({ t: at, kind: 'action', text: `Pressed ${e.mods}${e.key}${e.el ? ` in ${nameOf(e.el)}` : ''}`, textAr: `ضغط ${iso(`${e.mods}${e.key}`)}${e.el ? ` في ${nameOfAr(e.el)}` : ''}`, src: e.el?.src });
          if (e.key === 'Enter' && e.el?.locator) steps.push({ t: at, kind: 'press', locator: e.el.locator, key: 'Enter', description: `Press Enter in ${nameOf(e.el)}`, descriptionAr: `اضغط Enter في ${nameOfAr(e.el)}`, ...likeOf(e.el) });
        }
        break;
      case 'page':
      case 'nav': {
        const how = e.type === 'page' ? (e.reload ? 'Reloaded' : 'Opened') : e.how === 'pop' ? 'Went back to' : 'Went to';
        const howAr = e.type === 'page' ? (e.reload ? 'أعاد تحميل' : 'فتح') : e.how === 'pop' ? 'عاد إلى' : 'انتقل إلى';
        add({ t: at, kind: 'navigation', text: `${how} ${pathOf(e.url)}${e.title ? ` (“${e.title}”)` : ''}`, textAr: `${howAr} ${iso(pathOf(e.url))}${e.title ? ` («${iso(e.title)}»)` : ''}` });
        if (e.type === 'page' && !steps.length) steps.push({ t: at, kind: 'navigate', url: e.url, description: `Open ${pathOf(e.url)}`, descriptionAr: `افتح ${iso(pathOf(e.url))}` });
        break;
      }
      case 'scroll':
        if (!e.el && e.maxY > 0) add({ t: at, kind: 'action', text: `Scrolled to ${Math.round((e.y / e.maxY) * 100)}% of the page`, textAr: `مرّر إلى ${Math.round((e.y / e.maxY) * 100)}% من الصفحة` });
        break;
      case 'hover':
        if (e.ms >= 2500) add({ t: at, kind: 'action', text: `Rested on ${nameOf(e.el)} for ${fmtMs(e.ms)}`, textAr: `توقّف عند ${nameOfAr(e.el)} لمدة ${fmtMsAr(e.ms)}`, src: e.el.src });
        break;
      case 'error': {
        const uncaught = /^Uncaught\s+(?:\(in promise\)\s+)?/;
        const message = e.message.replace(uncaught, '');
        const normalized = normalizeText(e.message);
        const general = normalized.replace(uncaught, '');
        const title = (m: string) => (e.kind === 'resource' ? m : `${e.kind === 'rejection' ? 'Unhandled rejection' : 'JavaScript error'}: ${m.slice(0, 120)}`);
        const titleAr = (m: string) => (e.kind === 'resource' ? `فشل تحميل: ${iso(m)}` : `${e.kind === 'rejection' ? 'رفض وعد دون معالجة' : 'خطأ JavaScript'}: ${iso(m.slice(0, 120))}`);
        const g = occur(
          `err:${e.kind}:${normalized}`,
          () => ({ t: at, kind: 'error', text: `${e.kind === 'rejection' ? 'Unhandled promise rejection' : e.kind === 'resource' ? 'Load failure' : 'Error'}: ${message}${e.repeat ? ` (×${e.repeat + 1})` : ''}`, textAr: `${e.kind === 'rejection' ? 'رفض وعد (Promise) دون معالجة' : e.kind === 'resource' ? 'فشل تحميل' : 'خطأ'}: ${iso(message)}${e.repeat ? ` (×${e.repeat + 1})` : ''}`, detail: appStack(e.stack) ?? e.source }),
          () => ({ kind: 'error', severity: e.kind === 'resource' ? 'medium' : 'high', title: title(message), titleAr: titleAr(message), detail: appStack(e.stack) ?? e.source ?? '', t: at, src: stackSource(e.stack ?? e.source) }),
          { text: message, general: () => ({ title: title(general), titleAr: titleAr(general) }) },
        );
        g.count += e.repeat ?? 0;
        break;
      }
      case 'console': {
        const general = normalizeText(e.text.slice(0, 600));
        const item = () => ({ t: at, kind: 'console' as const, text: `Console ${e.level}: ${e.text.slice(0, 200)}${e.repeat ? ` (×${e.repeat + 1})` : ''}`, textAr: `${e.level === 'error' ? 'خطأ' : e.level === 'warn' ? 'تحذير' : 'رسالة'} في وحدة التحكم: ${iso(e.text.slice(0, 200))}${e.repeat ? ` (×${e.repeat + 1})` : ''}`, detail: e.stack });
        if (e.level === 'error') {
          const react = /^Warning: |React|validateDOMNesting|unique "key"|act\(/.test(e.text);
          const title = (m: string) => `Console error: ${m.slice(0, 110)}`;
          const titleAr = (m: string) => `خطأ في وحدة التحكم: ${iso(m.slice(0, 110))}`;
          const g = occur(`con:${general.slice(0, 160)}`, item, () => ({ kind: 'console', severity: react ? 'low' : 'medium', title: title(e.text), titleAr: titleAr(e.text), detail: e.text.slice(0, 600), t: at, src: stackSource(e.stack) }), {
            text: e.text,
            general: () => ({ title: title(general), titleAr: titleAr(general) }),
          });
          g.count += e.repeat ?? 0;
        } else {
          // A warning is no finding; its first few repeats show in the timeline.
          const seen = (consoleSeen.get(general) ?? 0) + 1;
          consoleSeen.set(general, seen);
          if (seen <= CONSOLE_REPEATS) add(item());
          else omitted++;
        }
        break;
      }
      case 'net': {
        const n = 1 + (e.repeat ?? 0);
        netTotal += n;
        const page = pathOf(e.url);
        const route = normalizePath(page.split('?')[0]);
        const key = `${e.method} ${route}`;
        const ep = endpoints.get(key) ?? { method: e.method, url: route, count: 0, failed: 0, totalMs: 0, statuses: new Set<number>() };
        ep.count += n;
        ep.totalMs += e.ms * n;
        ep.statuses.add(e.status);
        endpoints.set(key, ep);
        if (!e.ok && e.error !== 'aborted') {
          netFailed++;
          ep.failed++;
          const sev: Severity = e.status === 0 || e.status >= 500 ? 'high' : 'medium';
          occur(
            `net:${key}:${e.status}`,
            () => ({ t: at, kind: 'network', text: `${e.method} ${page} failed${e.status ? ` (${e.status})` : `: ${e.error ?? 'network error'}`} after ${fmtMs(e.ms)}`, textAr: `فشل ${iso(`${e.method} ${page}`)}${e.status ? ` (${e.status})` : `: ${e.error ?? 'خطأ في الشبكة'}`} بعد ${fmtMsAr(e.ms)}`, detail: e.body }),
            () => ({
              kind: 'network',
              severity: sev,
              title: `${key} ${e.status ? `returns ${e.status}` : 'fails'}`,
              detail: e.body ? `Response: ${e.body.slice(0, 400)}` : (e.error ?? ''),
              titleAr: `${iso(key)} ${e.status ? `يعيد ${e.status}` : 'يفشل'}`,
              detailAr: e.body ? `الاستجابة: ${iso(e.body.slice(0, 400))}` : (e.error ?? ''),
              t: at,
              url: e.url,
              src: stackSource(e.stack),
            }),
          );
        } else if (e.ok && e.ctype === 'text/html' && !/\.html?(\?|$)/i.test(page.split('?')[0]) && page.split('?')[0] !== '/') {
          // Dev servers answer unknown paths with the app's own page: the code asked for data and got a web page.
          netFailed++;
          ep.failed++;
          occur(
            `html:${key}`,
            () => ({ t: at, kind: 'network', text: `${e.method} ${page} returned a web page (HTML), not data`, textAr: `${iso(`${e.method} ${page}`)} أعاد صفحة ويب (HTML) لا بيانات` }),
            () => ({
              kind: 'network',
              severity: 'high',
              title: `${key} returns a web page instead of data`,
              detail: 'The request succeeded, but with HTML: most likely there is no such API route, and the dev server answered with the app’s page. Check the URL and the server.',
              titleAr: `${iso(key)} يعيد صفحة ويب بدل البيانات`,
              detailAr: 'نجح الطلب لكن بصيغة HTML: على الأرجح لا يوجد مسار API بهذا العنوان، فأجاب خادم التطوير بصفحة التطبيق. تحقّق من العنوان والخادم.',
              t: at,
              url: e.url,
              src: stackSource(e.stack),
            }),
          );
        } else if (e.ms >= SLOW_REQUEST_MS) {
          netSlow++;
          occur(
            `slow:${key}`,
            () => ({ t: at, kind: 'network', text: `${e.method} ${page} took ${fmtMs(e.ms)}`, textAr: `استغرق ${iso(`${e.method} ${page}`)} ${fmtMsAr(e.ms)}` }),
            () => ({ kind: 'performance', severity: e.ms > 4000 ? 'high' : 'medium', title: `${key} is slow (${fmtMs(e.ms)})`, detail: 'Users wait for this request.', titleAr: `${iso(key)} بطيء (${fmtMsAr(e.ms)})`, detailAr: 'المستخدم ينتظر هذا الطلب.', t: at, url: e.url }),
          );
        }
        break;
      }
      case 'rage': {
        refFile(e.el.src, 3);
        occur(
          `rage:${e.el.src ?? e.el.locator ?? e.el.label}`,
          () => ({ t: at, kind: 'frustration', text: `Rage-clicked ${nameOf(e.el)} (${e.clicks} clicks)`, textAr: `نقر بغضب على ${nameOfAr(e.el)} (${e.clicks} نقرات)`, src: e.el.src }),
          () => ({ kind: 'frustration', severity: 'high', title: `Rage clicks on ${nameOf(e.el)}`, detail: 'Several fast clicks on the same spot: the user expected something to happen.', titleAr: `نقرات غاضبة على ${nameOfAr(e.el)}`, detailAr: 'عدة نقرات سريعة في المكان نفسه: كان المستخدم يتوقّع أن يحدث شيء.', t: at, el: e.el, src: e.el.src }),
        );
        break;
      }
      case 'dead': {
        // A click that threw an error did something: the error is the finding, with this click as its cause.
        const near = firstAtOrAfter(errorTimes, e.t - 100);
        if (near < errorTimes.length && errorTimes[near] <= e.t + 1100) break;
        refFile(e.el.src, 2);
        occur(
          `dead:${e.el.src ?? e.el.locator ?? e.el.label}`,
          () => ({ t: at, kind: 'frustration', text: `Clicked ${nameOf(e.el)}, nothing happened`, textAr: `نقر على ${nameOfAr(e.el)} ولم يحدث شيء`, src: e.el.src }),
          () => ({ kind: 'frustration', severity: 'medium', title: `${nameOf(e.el).replace(/^the/, 'The')} looks clickable but does nothing`, detail: 'No page change, request, or response within a second of the click.', titleAr: `${nameOfAr(e.el)} يبدو قابلًا للنقر لكنه لا يفعل شيئًا`, detailAr: 'لا تغيّر في الصفحة ولا طلب ولا استجابة خلال ثانية من النقر.', t: at, el: e.el, src: e.el.src }),
        );
        break;
      }
      case 'perf': {
        // Anything but the page's load metrics from before the session isn't part of it (older recorders sent them).
        if (at < start && e.metric !== 'fcp' && e.metric !== 'lcp') break;
        if (e.metric === 'fcp') fcp = e.value;
        else if (e.metric === 'lcp') lcp = e.value;
        else if (e.metric === 'cls') {
          cls += e.value;
          if (e.value >= 0.05) {
            occur(
              `cls:${e.el?.src ?? 'page'}`,
              () => ({ t: at, kind: 'performance', text: `Layout shifted (${e.value})${e.el ? `: ${nameOf(e.el)} moved` : ''}`, textAr: `تحرّك التخطيط (${e.value})${e.el ? `: تحرّك ${nameOfAr(e.el)}` : ''}`, src: e.el?.src }),
              () => ({ kind: 'performance', severity: e.value >= 0.15 ? 'high' : 'medium', title: `Content jumps while loading${e.el ? ` (${nameOf(e.el)})` : ''}`, detail: 'Layout shift makes people click the wrong thing. Reserve space for content that loads late.', titleAr: `المحتوى يقفز أثناء التحميل${e.el ? ` (${nameOfAr(e.el)})` : ''}`, detailAr: 'إزاحة التخطيط تجعل الناس ينقرون على الشيء الخطأ. احجز مساحة للمحتوى الذي يتأخّر تحميله.', t: at, el: e.el, src: e.el?.src }),
            );
          }
        } else if (e.metric === 'inp') {
          slowest = Math.max(slowest ?? 0, e.value);
          occur(
            `inp:${e.el?.src ?? e.el?.locator ?? 'page'}`,
            () => ({ t: at, kind: 'performance', text: `Slow response to ${e.detail ?? 'input'}: ${fmtMs(e.value)} until the screen updated`, textAr: `استجابة بطيئة لـ ${e.detail ? iso(e.detail) : 'الإدخال'}: ${fmtMsAr(e.value)} حتى تحدّثت الشاشة`, src: e.el?.src }),
            () => ({ kind: 'performance', severity: e.value > 500 ? 'high' : 'medium', title: `Slow to respond${e.el ? ` after ${nameOf(e.el)}` : ''} (${fmtMs(e.value)})`, detail: 'Interactions should update the screen within 200 ms (INP).', titleAr: `بطء في الاستجابة${e.el ? ` بعد ${nameOfAr(e.el)}` : ''} (${fmtMsAr(e.value)})`, detailAr: 'يجب أن تتحدّث الشاشة خلال 200 مللي ثانية من أي تفاعل (INP).', t: at, el: e.el, src: e.el?.src }),
          );
        } else if (e.metric === 'longtask') {
          // Busy moments alone aren't findings: the tester may have been reading, thinking or talking, and a
          // response that kept them waiting is already measured above (slow response to input).
          longTasks++;
          longTaskMs += e.value;
        }
        break;
      }
      case 'mark': {
        const it = add({ t: at, kind: 'mark', text: `Marked: ${e.note || 'something here'}`, textAr: `علامة: ${e.note ? iso(e.note) : 'شيء هنا'}` });
        issue(`mark:${at}`, () => ({ kind: 'mark', severity: 'medium', title: e.note ? `Marked: ${e.note.slice(0, 100)}` : 'Marked moment', detail: 'The tester flagged this moment.', titleAr: e.note ? `علامة: ${iso(e.note.slice(0, 100))}` : 'لحظة معلَّمة', detailAr: 'علّم المختبِر هذه اللحظة.', t: at }), it);
        break;
      }
      case 'command':
        add({ t: at, kind: 'command', text: `Said “${e.text}” → ${e.result}`, textAr: `قال «${iso(e.text)}» ← ${iso(e.result)}` });
        break;
      case 'autopilot':
        add({ t: at, kind: 'command', text: `Autopilot: ${e.did}`, textAr: `القائد الآلي: ${iso(e.did)}`, detail: e.why, detailAr: iso(e.why) });
        break;
      case 'observed': {
        const detail = `Expected: ${e.expected}\nSaw: ${e.actual}`;
        occur(
          `observed:${e.title.toLowerCase()}`,
          () => ({ t: at, kind: 'mark', text: `Autopilot saw: ${e.title}`, textAr: `لاحظ القائد الآلي: ${iso(e.title)}`, src: e.el?.src ?? null }),
          () => ({ kind: 'observed', severity: e.severity, title: e.title.slice(0, 120), detail, titleAr: iso(e.title.slice(0, 120)), detailAr: `المتوقَّع: ${iso(e.expected)}\nالظاهر: ${iso(e.actual)}`, t: at, ...(e.el ? { el: e.el, src: e.el.src } : {}) }),
        );
        break;
      }
      case 'dropped':
        lost += e.count;
        break;
      case 'dom':
        looks.push({ t: at, url: e.url, reason: e.reason, text: e.text ?? '', action: e.reason === 'after' && lastAction && at - lastAction.t < 15_000 ? lastAction : null });
        break;
      case 'point':
      case 'trail':
      case 'focus':
      case 'resize':
      case 'vis':
        break;
    }
  }

  // ---- narration: link each sentence to what was being pointed at, and listen for complaints ----
  const pointers = events.filter((e): e is Extract<StoredEvent, { type: 'point' | 'hover' | 'click' }> => e.type === 'point' || e.type === 'hover' || e.type === 'click');
  const linked = transcript.map((s) => ({ ...s, el: s.el ?? linkedTo(pointers, s) }));
  linked.forEach((s, i) => {
    const it = add({ t: s.start, kind: 'speech', text: s.text, src: s.el?.src, detail: s.el ? `while pointing at ${nameOf(s.el)}` : undefined, detailAr: s.el ? `أثناء الإشارة إلى ${nameOfAr(s.el)}` : undefined });
    refFile(s.el?.src, 2);
    const severity = complaintSeverity(s.text);
    if (severity) {
      issue(`said:${i}`, () => ({
        kind: 'said',
        severity,
        title: `“${s.text.slice(0, 120)}”`,
        detail: s.el ? `Said while pointing at ${nameOf(s.el)}.` : 'Said during the session.',
        detailAr: s.el ? `قيل أثناء الإشارة إلى ${nameOfAr(s.el)}.` : 'قيل أثناء الجلسة.',
        t: s.start,
        el: s.el,
        src: s.el?.src,
      }), it);
    }
  });
  yield;

  // Problems whose wording varied from one occurrence to the next are titled by what they have in common.
  for (const [g, w] of wording) if (w.varied) Object.assign(g, w.general());

  // ---- scores (from every problem, before the lists are cut) ----
  const errorIssues = issues.filter((g) => g.kind === 'error');
  const stability = score(
    [
      ...errorIssues.map((g) => ({ points: (g.severity === 'high' ? 20 : 8) + Math.min(12, (g.count - 1) * 3), note: g.title, noteAr: g.titleAr })),
      ...issues.filter((g) => g.kind === 'network' && g.severity === 'high').map((g) => ({ points: 16 + Math.min(9, (g.count - 1) * 3), note: g.title, noteAr: g.titleAr })),
      ...issues.filter((g) => g.kind === 'network' && g.severity !== 'high').map((g) => ({ points: 6, note: g.title, noteAr: g.titleAr })),
      ...issues.filter((g) => g.kind === 'console' && g.severity !== 'low').map((g) => ({ points: 4, note: g.title, noteAr: g.titleAr })),
      ...issues.filter((g) => g.kind === 'console' && g.severity === 'low').map((g) => ({ points: 1, note: g.title, noteAr: g.titleAr })),
    ],
    'No errors, failed requests or crashes.',
    'لا أخطاء ولا طلبات فاشلة ولا أعطال.',
  );
  const usability = score(
    [
      ...issues.filter((g) => g.kind === 'frustration').map((g) => ({ points: g.severity === 'high' ? 14 : 7, note: g.title, noteAr: g.titleAr })),
      ...issues.filter((g) => g.kind === 'said').map((g) => ({ points: g.severity === 'high' ? 10 : 5, note: `Tester said ${g.title}`, noteAr: `قال المختبِر ${iso(g.title)}` })),
      ...issues.filter((g) => g.kind === 'mark').map((g) => ({ points: 3, note: g.title, noteAr: g.titleAr })),
      ...issues.filter((g) => g.kind === 'observed').map((g) => ({ points: g.severity === 'high' ? 14 : g.severity === 'medium' ? 7 : 3, note: `Autopilot saw: ${g.title}`, noteAr: `لاحظ القائد الآلي: ${g.titleAr ?? g.title}` })),
    ],
    'No signs of frustration or confusion.',
    'لا علامات على انزعاج أو حيرة.',
  );
  const perfD: Deduction[] = [];
  if (lcp != null && lcp > 2500) perfD.push({ points: lcp > 4000 ? 25 : 10, note: `Largest content painted after ${fmtMs(lcp)} (aim for 2.5 s)`, noteAr: `ظهر المحتوى الرئيسي بعد ${fmtMsAr(lcp)} (الهدف 2.5 ثانية)` });
  if (slowest != null && slowest > 200) perfD.push({ points: slowest > 500 ? 20 : 10, note: `Slowest interaction took ${fmtMs(slowest)} to update the screen (aim for 200 ms)`, noteAr: `أبطأ تفاعل احتاج ${fmtMsAr(slowest)} لتحديث الشاشة (الهدف 200 مللي ثانية)` });
  if (cls > 0.1) perfD.push({ points: cls > 0.25 ? 20 : 10, note: `Layout shift ${cls.toFixed(2)} (aim for under 0.1)`, noteAr: `إزاحة التخطيط ${cls.toFixed(2)} (الهدف أقل من 0.1)` });
  if (netSlow) perfD.push({ points: Math.min(20, netSlow * 5), note: `${netSlow} slow request${netSlow > 1 ? 's' : ''} (over ${fmtMs(SLOW_REQUEST_MS)})`, noteAr: `${netSlow} ${netSlow > 1 ? 'طلبات بطيئة' : 'طلب بطيء'} (أكثر من ${fmtMsAr(SLOW_REQUEST_MS)})` });
  if (longTaskMs > 1000) perfD.push({ points: Math.min(8, longTaskMs / 500), note: `The app’s own work kept the page busy for ${fmtMs(longTaskMs)} in total`, noteAr: `أبقى عمل التطبيق نفسه الصفحة مشغولة ${fmtMsAr(longTaskMs)} إجمالًا` });
  const performance = score(perfD, `Fast: ${lcp != null ? `content in ${fmtMs(lcp)}, ` : ''}no slow interactions.`, `سريع: ${lcp != null ? `ظهر المحتوى خلال ${fmtMsAr(lcp)}، و` : ''}لا تفاعلات بطيئة.`);
  const accessibility = score(
    issues.filter((g) => g.kind === 'accessibility').map((g) => ({ points: g.severity === 'medium' ? 8 : 4, note: g.title, noteAr: g.titleAr })),
    'No problems found in what was used (checked: names, labels, target sizes).',
    'لا مشكلات فيما استُخدم (فُحص: الأسماء والتسميات وأحجام الأهداف).',
  );
  // The weighted mean, held down by the weakest area and by the worst problem: a session with a
  // high-severity issue is never "good", and one with a critical issue is never better than poor.
  const weighted = stability.score * 0.35 + usability.score * 0.3 + performance.score * 0.2 + accessibility.score * 0.15;
  const weakest = Math.min(stability.score, usability.score, performance.score, accessibility.score);
  const overall = clamp(Math.min(weighted, weakest + 25, scoreCap(worstOf(issues.map((g) => g.severity)))));
  const scores: SessionScores = { overall, stability, usability, performance, accessibility };
  yield;

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const kindOrder: Record<IssueKind, number> = { error: 0, network: 1, said: 2, observed: 2, frustration: 3, mark: 4, performance: 5, console: 6, accessibility: 7 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || kindOrder[a.kind] - kindOrder[b.kind] || b.count - a.count || a.t - b.t);

  // ---- the first ISSUES_PER_KIND problems of each kind; the rest are counted, their moments left out ----
  const perKind = new Map<IssueKind, number>();
  const moreIssues: Partial<Record<IssueKind, number>> = {};
  const dropped = new Set<string>();
  const kept = issues.filter((g) => {
    const k = (perKind.get(g.kind) ?? 0) + 1;
    perKind.set(g.kind, k);
    if (k <= ISSUES_PER_KIND) return true;
    moreIssues[g.kind] = (moreIssues[g.kind] ?? 0) + 1;
    dropped.add(g.id);
    return false;
  });
  const listed = capTimeline(dropped.size ? timeline.filter((it) => !it.issue || !dropped.has(it.issue)) : timeline);
  omitted += timeline.length - listed.length;
  yield;

  // ---- screenshots on the timeline, and the closest one for each issue ----
  for (const shot of shots) listed.push({ id: '', t: shot.t, kind: 'shot', text: `Screenshot (${shot.reason})`, textAr: `لقطة شاشة (${shot.reason})`, shot: shot.name });
  for (const g of issues) refFile(g.src, 2);
  for (const g of kept) {
    const near = closestShot(shots, g.t);
    if (near) g.shot = near.name;
  }

  // Readable, stable ids in time order: E (app events), S (sentences), P (pictures).
  listed.sort((a, b) => a.t - b.t);
  const counters = { E: 0, S: 0, P: 0 };
  for (const it of listed) {
    const prefix = it.kind === 'speech' ? 'S' : it.kind === 'shot' ? 'P' : 'E';
    it.id = `${prefix}${++counters[prefix]}`;
  }
  for (const g of kept) g.evidence = (proof.get(g) ?? []).map((it) => it.id).filter(Boolean);
  const screens = screenTexts(looks);

  return {
    version: 1,
    durationMs: Math.max(0, end - start),
    pages,
    issues: kept,
    scores,
    timeline: listed,
    steps,
    perf: { fcp, lcp, cls: +cls.toFixed(3), slowestInteraction: slowest, longTasks, longTaskMs: Math.round(longTaskMs) },
    network: {
      total: netTotal,
      failed: netFailed,
      slow: netSlow,
      endpoints: Array.from(endpoints.values())
        .sort((a, b) => b.failed - a.failed || b.count - a.count)
        .slice(0, 30)
        .map((e) => ({ method: e.method, url: e.url, count: e.count, failed: e.failed, avgMs: Math.round(e.totalMs / e.count), statuses: Array.from(e.statuses).sort() })),
    },
    ...(summarised ? { summarised } : {}),
    ...(lost ? { dropped: lost } : {}),
    transcript: linked,
    shots,
    ...(screens.length ? { screens } : {}),
    ...(startState ? { startState } : {}),
    end,
    files: Array.from(fileRefs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([path, refs]) => ({ path, refs })),
    ...(omitted || dropped.size ? { more: { issues: moreIssues, timeline: omitted } } : {}),
  };
}

/**
 * The timeline within MAX_TIMELINE moments. What was said, marks, pages and commands stay, then problems' evidence;
 * routine actions, then warnings, are thinned evenly (in time) to fit.
 */
function capTimeline(items: TimelineItem[]): TimelineItem[] {
  if (items.length <= MAX_TIMELINE) return items;
  const rank = (it: TimelineItem) => (it.kind === 'speech' || it.kind === 'mark' || it.kind === 'navigation' || it.kind === 'command' ? 0 : it.issue ? 1 : it.kind === 'console' ? 3 : 2);
  const byRank: TimelineItem[][] = [[], [], [], []];
  for (const it of items) byRank[rank(it)].push(it);
  const keep = new Set<TimelineItem>();
  let room = MAX_TIMELINE;
  for (const list of byRank) {
    const take = Math.min(room, list.length);
    for (let i = 0; i < take; i++) keep.add(list[Math.floor((i * list.length) / take)]);
    room -= take;
  }
  return items.filter((it) => keep.has(it));
}

/** For a step whose locator goes by the element's place in the code: what the element was, to find it again once a fix has moved it. */
function likeOf(el: SessionTarget): Pick<SessionStep, 'like'> {
  return el.locator?.startsWith('page.locator(\'[data-ds-src=') ? { like: { tag: el.tag, name: el.name, text: el.text, ...(el.shape ? { shape: el.shape } : {}) } } : {};
}

/** What the user was pointing at, hovering or clicking while saying something. */
function pointedAt(pointers: { t: number; type: string; el: SessionTarget; ms?: number }[], start: number, end: number): SessionTarget | null {
  let best: { el: SessionTarget; weight: number } | null = null;
  for (const p of pointers) {
    const pStart = p.t;
    const pEnd = p.type === 'click' ? p.t + 300 : p.t + (p.ms ?? 0);
    const overlap = Math.min(end + 500, pEnd) - Math.max(start - 1500, pStart);
    if (overlap <= 0) continue;
    // Explicit pointing (hand or mouse from the studio) beats a click, which beats a hover.
    const weight = overlap * (p.type === 'point' ? 3 : p.type === 'click' ? 2 : 1);
    if (!best || weight > best.weight) best = { el: p.el, weight };
  }
  return best?.el ?? null;
}

/**
 * What a sentence was about: what was pointed at while it was said. When it says what something should show, what
 * was pointed at while that part was said counts (a long sentence can be about something else first).
 */
function linkedTo(pointers: { t: number; type: string; el: SessionTarget; ms?: number }[], s: TranscriptSegment): SessionTarget | null {
  const said = saidValue(s.text);
  const el = (said && said.at > 0 ? pointedAt(pointers, saidAt(s, said), s.end) : null) ?? pointedAt(pointers, s.start, s.end);
  if (!el || el.locator || !el.src) return el;
  // Known only as the studio saw it (sessions from before it named what was pointed at): the app's name for the same element.
  const same = pointers.find((p) => p.el.locator && p.el.src === el.src && (p.el.label === el.label || (!!el.text && p.el.text === el.text)));
  return same ? { ...el, locator: same.el.locator, description: same.el.description, ...(same.el.shape ? { shape: same.el.shape } : {}) } : el;
}

function closestShot(shots: SessionShot[], t: number): SessionShot | null {
  let best: SessionShot | null = null;
  for (const s of shots) {
    // Prefer a shot taken just after the moment (it shows the result).
    const d = s.t >= t ? s.t - t : (t - s.t) * 2;
    if (d > 8000) continue;
    if (!best || d < (best.t >= t ? best.t - t : (t - best.t) * 2)) best = s;
  }
  return best;
}

/** The app's own frame in a stack trace, as a project path: src/lib/pricing.ts:32:5. */
/** A stack trace as a developer reads it: the message, then the app's own frames (not React's or the bundler's). */
function appStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] && !lines[0].startsWith('at ') ? [lines[0]] : [];
  const frames = lines.filter((l) => l.startsWith('at '));
  const own = frames.filter((l) => !/node_modules|\/@vite\/|react-dom|react\.development|scheduler|\/_next\/static\/chunks\/(?:framework|main|webpack)|\(native\)|<anonymous>/.test(l));
  return [...head, ...(own.length ? own : frames).slice(0, 4)].join('\n');
}

export function stackSource(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const line of stack.split('\n')) {
    if (/node_modules|@vite|react-dom/.test(line)) continue;
    // Already traced to the project through source maps: "at onClick (src/App.tsx:32:154)".
    const traced = /[\s(]((?![a-z][\w+.-]*:)[\w@.-][^\s():]*\.[cm]?[jt]sx?):(\d+):(\d+)\)?\s*$/i.exec(line);
    if (traced && !traced[1].startsWith('/')) return `${traced[1]}:${traced[2]}:${traced[3]}`;
    // A dev server's address for an app file.
    const m = /(?:https?:\/\/[^/\s]+)?\/((?:src|app|pages|components|lib)\/[^\s?:)]+\.[jt]sx?)(?:\?[^:\s)]*)?:(\d+):(\d+)/.exec(line);
    if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  }
  return null;
}

