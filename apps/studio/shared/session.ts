/**
 * Test sessions: what the studio records while you use your app, what it
 * finds in it, and the report it writes. Shared by the studio and its server.
 */
import type { SessionEvent, SessionTarget } from '@saywright/vite/protocol';

export type { SessionEvent, SessionTarget };

type SessionStatus = 'recording' | 'processing' | 'ready' | 'failed';
/** Narration language: a fixed language, or detected per sentence. */
export type SessionLang = 'en' | 'ar' | 'auto';

export interface SessionMeta {
  id: string;
  name: string;
  appUrl: string;
  /** Where it was started: the studio, the app's own tab, or a replay checking an earlier session (`replayOf`). */
  source: 'studio' | 'app' | 'replay' | 'autopilot';
  replayOf?: string;
  lang: SessionLang;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  /** What the processing step is doing, while it runs. */
  stage?: string;
  error?: string;
  git?: { branch: string; commit: string; dirty: boolean } | null;
  counts: SessionCounts;
  /** Seconds of narration audio received. */
  audioSeconds: number;
  video: { mime: string; startedAt: number; bytes: number; parts?: VideoPart[] } | null;
  /**
   * When the studio restarted while it recorded, and whether the page recording it went on afterwards (it keeps what
   * it records while the studio is away, and sends it once it is back).
   */
  restarts?: { at: number; resumed: boolean }[];
  /** The person named it: the list shows that name rather than the report's title. */
  renamed?: boolean;
  /** The report, in brief: its findings are counted (reports written before they were have no count). */
  report?: { source: 'ai' | 'claude' | 'local'; model?: string; at: number; overall: number; title: string; scores?: ScoreSummary; findings?: number };
}

/** A report's scores as numbers only, kept with the session so a later report can compare without reading this one's analysis. */
export type ScoreSummary = { overall: number } & Record<'stability' | 'usability' | 'performance' | 'accessibility', number>;

/** One continuous screen recording; sharing again (after a reload) starts another. */
export interface VideoPart {
  startedAt: number;
  bytes: number;
  file: string;
  /** Length, once the session has been processed. */
  ms?: number;
}

interface SessionCounts {
  events: number;
  clicks: number;
  inputs: number;
  pages: number;
  errors: number;
  failedRequests: number;
  frustration: number;
  marks: number;
  speech: number;
  shots: number;
}

/** A session's length for labels: "45 s", "3 min", "1 h 05 min". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** The same in words, for sentences: "45 seconds", "1 minute", "1 hour 5 minutes". */
export function durationWords(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return plural(s, 'second');
  const m = Math.round(s / 60);
  return m < 60 ? plural(m, 'minute') : `${plural(Math.floor(m / 60), 'hour')}${m % 60 ? ` ${plural(m % 60, 'minute')}` : ''}`;
}

/** Arabic number agreement: "ثانية واحدة", "ثانيتان", "3 ثوانٍ", "15 ثانية". */
export function arCount(n: number, [one, two, few, many]: readonly [string, string, string, string]): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const AR_UNITS = {
  second: ['ثانية واحدة', 'ثانيتان', 'ثوانٍ', 'ثانية'],
  minute: ['دقيقة واحدة', 'دقيقتان', 'دقائق', 'دقيقة'],
  hour: ['ساعة واحدة', 'ساعتان', 'ساعات', 'ساعة'],
  page: ['صفحة واحدة', 'صفحتان', 'صفحات', 'صفحة'],
  issue: ['مشكلة واحدة', 'مشكلتان', 'مشكلات', 'مشكلة'],
  step: ['خطوة واحدة', 'خطوتان', 'خطوات', 'خطوة'],
  request: ['طلب واحد', 'طلبان', 'طلبات', 'طلبًا'],
} as const;

/** A session's length in Arabic words: "13 ثانية", "3 دقائق", "ساعة واحدة و5 دقائق". */
export function durationWordsAr(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return arCount(s, AR_UNITS.second);
  const m = Math.round(s / 60);
  return m < 60 ? arCount(m, AR_UNITS.minute) : `${arCount(Math.floor(m / 60), AR_UNITS.hour)}${m % 60 ? ` و${arCount(m % 60, AR_UNITS.minute)}` : ''}`;
}

export const EMPTY_COUNTS: SessionCounts = { events: 0, clicks: 0, inputs: 0, pages: 0, errors: 0, failedRequests: 0, frustration: 0, marks: 0, speech: 0, shots: 0 };

/** A stretch of narration, transcribed on this computer. Times are wall-clock ms. */
export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  lang: string;
  model: string;
  /** How long transcription took. */
  ms: number;
  /** Where it starts in the narration recording (audio.wav), in seconds. */
  audioAt?: number;
  /** What was pointed at or clicked while it was said. */
  el?: SessionTarget | null;
  /** What the recogniser heard, when the tester corrected it (`text` is then the correction). */
  original?: string;
  /** When the tester last corrected it. */
  editedAt?: number;
}

export interface SessionShot {
  name: string;
  t: number;
  reason: string;
  w: number;
  h: number;
}

/** `observed`: a problem Autopilot saw. */
export type IssueKind = 'error' | 'network' | 'console' | 'frustration' | 'performance' | 'said' | 'observed' | 'mark' | 'accessibility';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Something worth a look, found without AI. Evidence ids point into the timeline. */
export interface SessionIssue {
  id: string;
  /** What makes two occurrences the same problem (an error's message, a request's endpoint, a dead button's source), to tell whether it happens again. */
  key?: string;
  kind: IssueKind;
  severity: Severity;
  title: string;
  detail: string;
  /** The same in Arabic, for the report in Arabic. */
  titleAr?: string;
  detailAr?: string;
  t: number;
  count: number;
  evidence: string[];
  el?: SessionTarget | null;
  src?: string | null;
  url?: string;
  /** Screenshot taken closest to it. */
  shot?: string;
}

export interface ScoreBreakdown {
  score: number;
  notes: string[];
  /** The same notes in Arabic. */
  notesAr?: string[];
}

export interface SessionScores {
  overall: number;
  stability: ScoreBreakdown;
  usability: ScoreBreakdown;
  performance: ScoreBreakdown;
  accessibility: ScoreBreakdown;
}

/** One line of the merged timeline: an app event, a sentence, a screenshot. */
export interface TimelineItem {
  id: string;
  t: number;
  kind: 'action' | 'navigation' | 'speech' | 'error' | 'network' | 'frustration' | 'performance' | 'mark' | 'shot' | 'command' | 'console';
  text: string;
  /** The same in Arabic (a sentence keeps the words as said). */
  textAr?: string;
  detail?: string;
  detailAr?: string;
  src?: string | null;
  issue?: string;
  shot?: string;
}

export interface SessionStep {
  t: number;
  kind: 'click' | 'fill' | 'press' | 'navigate';
  locator?: string;
  value?: string;
  /** A checkbox or radio button: ticked or not, after the step. */
  checked?: boolean;
  /** A secret was typed: the name a test types it under (PASSWORD); `value` is empty. */
  secret?: string;
  /** A choice in a list: what each option chosen says. */
  select?: string[];
  key?: string;
  url?: string;
  description: string;
  descriptionAr?: string;
  /** What the element was, when the locator goes by its place in the code (a fix can move it). */
  like?: { tag: string; name: string; text: string; shape?: string };
}

/** What the screen said at one moment of a session (see SessionAnalysis.screens). */
export interface ScreenText {
  t: number;
  url: string;
  /** When it was read: start, reload, navigation, error, mark, or after an action. */
  moment: string;
  /** The action it followed: its words, and its timeline id when the timeline lists it. */
  after?: { id?: string; text: string };
  /**
   * The page's text in full (as it first showed), or with `diff` what changed since the screen before: “+ ” appeared,
   * “- ” went away, “  ” unchanged around a change, “…” unchanged lines left out.
   */
  lines: string[];
  diff: boolean;
  /** Lines left out at the end. */
  more?: number;
}

export interface SessionAnalysis {
  version: 1;
  durationMs: number;
  pages: { url: string; title: string; t: number; ms: number }[];
  issues: SessionIssue[];
  scores: SessionScores;
  timeline: TimelineItem[];
  steps: SessionStep[];
  perf: { fcp: number | null; lcp: number | null; cls: number; slowestInteraction: number | null; longTasks: number; longTaskMs: number };
  network: { total: number; failed: number; slow: number; endpoints: { method: string; url: string; count: number; failed: number; avgMs: number; statuses: number[] }[] };
  /** Repeats the app's page counted into one event like them (the same error, quick requests to one address): each is in the counts above. */
  summarised?: number;
  /** Events the app's page couldn't keep while the studio wasn't taking them. */
  dropped?: number;
  transcript: TranscriptSegment[];
  shots: SessionShot[];
  /** What the screen said: each page as it first showed, then what changed once it settled after an action. */
  screens?: ScreenText[];
  /** Source files the session touched, most referenced first. */
  files: { path: string; refs: number }[];
  /**
   * What a long, noisy session left out to stay readable: problems past the first 200 of a kind (counted here by
   * kind), and moments not listed in the timeline (repeats of a problem past its evidence, routine actions).
   */
  more?: { issues: Partial<Record<IssueKind, number>>; timeline: number };
}

export type FindingCategory = 'bug' | 'usability' | 'performance' | 'accessibility' | 'content' | 'reliability';

export interface ReportFinding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  /** What happened, in plain words. */
  what: string;
  /** What should have happened. */
  expected: string;
  /** The user's own words that point at it, if any. */
  quote: string;
  /** Evidence ids from the timeline (events, sentences, screenshots). */
  evidence: string[];
  /** Where it showed (the code of what was on screen), file:line, when it differs from where to fix it. */
  shown?: string;
  /** Best guess at where to fix it, the cause: file:line, when known. */
  location: string;
  fix: string;
  /** Steps to reproduce. */
  steps: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface ReportSuggestion {
  kind: 'fix' | 'improve' | 'add';
  title: string;
  why: string;
  effort: 'small' | 'medium' | 'large';
}

export interface SessionReport {
  /** Language the report is written in. */
  lang: 'en' | 'ar';
  title: string;
  summary: string;
  verdict: 'ship' | 'fix-first' | 'blocked';
  /** One sentence per score explaining it. */
  scoreNotes: { stability: string; usability: string; performance: string; accessibility: string };
  findings: ReportFinding[];
  suggestions: ReportSuggestion[];
  positives: string[];
  /** What the tester tried to do, as a short story. */
  journey: string[];
  nextSteps: string[];
  /** "ai": written by a model ("claude" in reports written before other providers); "local": on this computer. */
  source: 'ai' | 'claude' | 'local';
  model?: string;
  at: number;
  ms?: number;
  /** A translation: the language it was translated from. */
  translatedFrom?: 'en' | 'ar';
  /** A translation: the model that translated it (`model` wrote the report). */
  translatedBy?: string;
}

/** What the tester decided about the report. */
export interface ReportDecisions {
  /** Findings set aside as not worth fixing (by title, so they survive the report being rewritten). */
  skipped: string[];
}

export const NO_DECISIONS: ReportDecisions = { skipped: [] };

export interface SessionDetail {
  meta: SessionMeta;
  analysis: SessionAnalysis | null;
  report: SessionReport | null;
  /** The same report in the other language (Arabic for an English report, and the other way round). */
  translation: SessionReport | null;
  /** The translation is being written. */
  translating: boolean;
  decisions: ReportDecisions;
  /** The session before this one on the same app, for comparison. */
  previous: { id: string; name: string; startedAt: number; scores: SessionScores | null } | null;
  /** The last replay of this session's steps, after fixes: what still happens. */
  verification: SessionVerification | null;
  /** A replay is being compared with this session right now. */
  verifying: boolean;
}

export type Verdict = 'fixed' | 'still' | 'unknown';

/** What a replay found about one problem: gone, still there, or not something a replay can tell. */
export interface VerifyResult {
  verdict: Verdict;
  why: string;
  whyAr: string;
}

/** What a replay checked in the app as it went: a value the tester said something should show. */
export interface ReplayCheck {
  /** The finding (report) or issue (analysis) it is about. */
  finding?: string;
  issue?: string;
  expected: string;
  /** What it showed in the replay (null: the element wasn't there). */
  actual: string | null;
  ok: boolean;
}

/** How a replay went, as the studio played it. */
export interface ReplayOutcome {
  /** Steps played; `failed`: the first one that couldn't be (what comes after it wasn't reached). */
  steps: { total: number; done: number; failed?: { i: number; t: number; description: string; descriptionAr?: string; reason: string } };
  checks: ReplayCheck[];
}

/** Why a replay couldn't play a step, in words: the codes come from the app's bridge and the studio. */
const REPLAY_REASONS: Record<string, { en: string; ar: string }> = {
  missing: { en: 'not found on the page', ar: 'لم يُعثر عليه في الصفحة' },
  hidden: { en: 'it was hidden', ar: 'كان مخفيًا' },
  unreadable: { en: 'the recorded step couldn’t be read', ar: 'تعذّرت قراءة الخطوة المسجّلة' },
  file: { en: 'a replay can’t choose files for you', ar: 'لا تستطيع الإعادة اختيار الملفات عنك' },
  'no-option': { en: 'that choice isn’t in the list any more', ar: 'هذا الخيار لم يعد في القائمة' },
  'not-a-field': { en: 'it can’t be typed into', ar: 'لا يمكن الكتابة فيه' },
  'not-recording': { en: 'the app didn’t start recording', ar: 'لم يبدأ التطبيق التسجيل' },
  error: { en: 'something went wrong', ar: 'حدث خطأ' },
  disabled: { en: 'it was disabled, so a person couldn’t use it either', ar: 'كان معطّلًا، فلا يستطيع أحد استخدامه' },
  secret: { en: 'it needs a secret that isn’t saved (the Test tab keeps them)', ar: 'يحتاج قيمة سرية غير محفوظة (تحفظها لسان الاختبار)' },
  'no-effect': { en: 'it did nothing this time', ar: 'لم يفعل شيئًا هذه المرة' },
  stopped: { en: 'you stopped it', ar: 'أوقفتَها أنت' },
  timeout: { en: 'the app didn’t answer', ar: 'لم يستجب التطبيق' },
  disconnected: { en: 'the app wasn’t connected', ar: 'لم يكن التطبيق متصلًا' },
};

export const replayReason = (code: string, lang: 'en' | 'ar'): string => REPLAY_REASONS[code]?.[lang] ?? code;

/** A session's steps played again, after fixes, compared with what happened the first time. */
export interface SessionVerification {
  at: number;
  /** The replay's own session (kept out of the list). */
  replay: string;
  steps: ReplayOutcome['steps'];
  /** By issue id (the analysis) and by finding id (the report). */
  issues: Record<string, VerifyResult>;
  findings: Record<string, VerifyResult>;
  /** Problems the replay ran into that the session didn't have. */
  fresh: { title: string; titleAr?: string; kind: IssueKind; severity: Severity }[];
}

/** Live updates while recording, over the studio's event stream. */
/** Whether narration is being transcribed as it is spoken: the model is loading, it is, or it can't be on this computer. */
export type NarrationState = 'loading' | 'live' | 'off';

export type SessionLive =
  | { kind: 'counts'; id: string; counts: SessionCounts; audioSeconds: number; narration?: NarrationState }
  | { kind: 'speech'; id: string; segment: TranscriptSegment }
  | { kind: 'status'; id: string; status: SessionStatus; stage?: string; error?: string }
  | { kind: 'issue'; id: string; text: string; t: number }
  /** The report changed without the session's status changing (its translation arrived, a sentence was corrected). */
  | { kind: 'report'; id: string };
