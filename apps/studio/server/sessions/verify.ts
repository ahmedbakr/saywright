/**
 * After a fix: a session's steps were played again in the app and recorded as
 * a session of their own. Each problem the first session had is looked for in
 * the replay the way it was found the first time (the same error, the same
 * failing request, the same button doing nothing), a value the tester said
 * something should show is checked against what it shows now, and so is an
 * amount a finding expects after a step, on the screen after the same step.
 */
import { amountsIn, moneyText, showsValue } from '../../shared/expected.ts';
import { replayReason, type ReplayCheck, type ReplayOutcome, type ReportFinding, type ScreenText, type SessionAnalysis, type SessionIssue, type SessionReport, type SessionStep, type SessionVerification, type VerifyResult } from '../../shared/session.ts';

/**
 * A problem's key, with what varies between runs taken out: numbers (ids, counts), quotes, the exact failing status.
 * Placeholders the analysis already wrote ({id}, {n}, {time}) count as numbers, so keys from before it wrote them match.
 */
export function normKey(key: string): string {
  const k = key
    .toLowerCase()
    .replace(/["'“”‘’`]/g, '')
    .replace(/\{(?:id|n|time)\}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  // A request that failed with one status and now fails with another is still failing.
  return k.replace(/^(net:.*):#$/, '$1');
}

/** The keys a replay would show this problem under. */
function lookFor(issue: SessionIssue): string[] {
  const key = issue.key ? normKey(issue.key) : '';
  if (!key) return [];
  // Clicking again and again on something that did nothing: in a replay (one click per click), it is still doing nothing.
  if (key.startsWith('rage:')) return [key, `dead:${key.slice(5)}`];
  return [key];
}

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
const fixed = (why: string, whyAr: string): VerifyResult => ({ verdict: 'fixed', why, whyAr });
const still = (why: string, whyAr: string): VerifyResult => ({ verdict: 'still', why, whyAr });
const unknown = (why: string, whyAr: string): VerifyResult => ({ verdict: 'unknown', why, whyAr });

/** A value read by the replay: shown now, still not, or not checked at all when what it was said about wasn't found. */
function checked(check: ReplayCheck): VerifyResult {
  if (check.ok) return fixed(`It shows ${check.expected} now.`, `يظهر الآن ${check.expected}.`);
  if (check.actual == null) return unknown(`What it was said about wasn’t found in the replay, so ${check.expected} couldn’t be checked.`, `لم تجد الإعادة ما قيل عنه هذا، فتعذّر التحقّق من ${check.expected}.`);
  return still(`It shows ${check.actual.slice(0, 80)}, not ${check.expected}.`, `يظهر ${check.actual.slice(0, 80)} وليس ${check.expected}.`);
}

/** Whether the replay made a request to this endpoint ("GET /api/items"). */
function requested(replay: SessionAnalysis, endpoint: string): boolean {
  const want = normKey(endpoint);
  return replay.network.endpoints.some((e) => normKey(`${e.method} ${e.url}`) === want);
}

/** The steps a replay plays, in order (as the studio's replayer picks them). */
const playable = (a: SessionAnalysis): SessionStep[] => a.steps.filter((s) => s.kind !== 'navigate' && !!s.locator);

/** A session's reads of the screen were thinned to stay within a size: a read missing from them says nothing. */
const thinned = (screens: ScreenText[]) => screens.length >= 140 || screens.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.length + 1, 0), 0) > 50_000;

/**
 * The step a problem came after, when it changed the screen the first time and changed nothing after the same step
 * in the replay: it was done, but it didn't do what it did. Whatever came of it then can't be judged from the replay.
 */
export function noEffect(original: SessionAnalysis, replay: SessionAnalysis, issue: SessionIssue): SessionStep | null {
  const steps = playable(original);
  let i = -1;
  for (let k = 0; k < steps.length && steps[k].t <= issue.t; k++) i = k;
  if (i < 0) return null;
  const step = steps[i];
  const end = steps[i + 1]?.t ?? Infinity;
  const screens = original.screens ?? [];
  const at = screens.findIndex((s) => !!s.after && s.t > step.t && s.t < end);
  // Nothing changed on screen after it the first time either (a dead button, an error with nothing shown): no measure.
  if (at < 0) return null;
  const again = replay.screens ?? [];
  if (thinned(screens) || thinned(again)) return null;
  const text = screens[at].after!.text;
  const nth = screens.slice(0, at).filter((s) => s.after?.text === text).length;
  return again.filter((s) => s.after?.text === text)[nth] ? null : step;
}

/**
 * How long after the step a problem came after it took to show the first time, and how long the replay listened
 * after the same step (until its next step, or its end). Null when the problem came before any step.
 */
export function listened(original: SessionAnalysis, replay: SessionAnalysis, issue: SessionIssue): { lag: number; heard: number } | null {
  const steps = playable(original);
  let i = -1;
  for (let k = 0; k < steps.length && steps[k].t <= issue.t; k++) i = k;
  if (i < 0) return null;
  const again = playable(replay);
  const step = again[i];
  if (!step) return { lag: issue.t - steps[i].t, heard: 0 };
  const end = replay.end ?? Math.max(step.t, ...replay.timeline.map((x) => x.t));
  return { lag: issue.t - steps[i].t, heard: (again[i + 1]?.t ?? end) - step.t };
}

function verifyIssues(original: SessionAnalysis, replay: SessionAnalysis, outcome: ReplayOutcome): Record<string, VerifyResult> {
  const failed = outcome.steps.failed;
  // The app's saved data (storage, cookies) wasn't what it was when the session was recorded: a problem that came of it may not come again.
  const waiting = replay.issues.find((r) => r.key?.startsWith('pending:'));
  const otherData = !!original.startState && !!replay.startState && original.startState !== replay.startState;
  // Nothing arrived from the app: no page, no action. Nothing can be said to be gone.
  const recorded = replay.pages.length > 0 || replay.timeline.length > 0;
  const reachedUntil = failed ? failed.t : Infinity;
  const replayKeys = new Map<string, SessionIssue>();
  for (const r of replay.issues) if (r.key) replayKeys.set(normKey(r.key), r);
  const out: Record<string, VerifyResult> = {};
  for (const o of original.issues) {
    const key = o.key ? normKey(o.key) : '';
    const check = outcome.checks.find((c) => c.issue === o.id);
    if (check) {
      out[o.id] = checked(check);
      continue;
    }
    if (!recorded) {
      out[o.id] = unknown('The replay wasn’t recorded, so nothing could be compared: try again.', 'لم تُسجَّل الإعادة، فلم يُقارَن شيء: حاول مرة أخرى.');
      continue;
    }
    if (o.kind === 'mark') {
      out[o.id] = unknown('A moment you marked: watch the replay to judge it.', 'لحظة علّمتها: شاهد الإعادة لتحكم عليها.');
      continue;
    }
    if (o.kind === 'said') {
      out[o.id] = unknown('What was said here can’t be checked by a replay: watch it to judge.', 'ما قيل هنا لا تتحقّق منه الإعادة تلقائيًا: شاهدها لتحكم.');
      continue;
    }
    if (o.kind === 'observed') {
      out[o.id] = unknown('Autopilot judged this from the page: watch the replay, or run Autopilot again.', 'حكم القائد الآلي على هذا من الصفحة: شاهد الإعادة أو شغّل القائد الآلي مجددًا.');
      continue;
    }
    if (o.t >= reachedUntil && failed) {
      // A button that did nothing because it was disabled, and still is: the replay couldn't press it either.
      const stuck = failed.reason === 'disabled' && /^(?:dead|disabled|rage):/.test(key) && o.t - failed.t < 3000;
      out[o.id] = stuck
        ? still(`It is still disabled: ${failed.description}.`, `ما زال معطّلًا: ${failed.descriptionAr ?? failed.description}.`)
        : unknown(`The replay stopped before this: ${failed.description} (${replayReason(failed.reason, 'en')}).`, `توقّفت الإعادة قبل هذا: ${failed.descriptionAr ?? failed.description} (${replayReason(failed.reason, 'ar')}).`);
      continue;
    }
    if (key.startsWith('inp:') || key.startsWith('disabled:')) {
      out[o.id] = unknown('How quickly it responds isn’t measured in a replay: try it by hand.', 'سرعة الاستجابة لا تُقاس في الإعادة: جرّبها بنفسك.');
      continue;
    }
    const again = lookFor(o).map((k) => replayKeys.get(k)).find(Boolean);
    if (again) {
      out[o.id] = still(`It happened again: ${again.title}`, `تكرّر: ${again.titleAr ?? again.title}`);
      continue;
    }
    // A request problem is gone only if the replay made the request.
    const endpoint = key.startsWith('net:') || key.startsWith('html:') || key.startsWith('slow:') ? o.key!.replace(/^(net|html|slow):/, '').replace(/:\d+$/, '') : null;
    if (endpoint && !requested(replay, endpoint)) {
      out[o.id] = unknown('The replay didn’t make this request, so it couldn’t tell.', 'لم ترسل الإعادة هذا الطلب، فلم تستطع الحكم.');
      continue;
    }
    // Gone only if the step it came after did what it did the first time: else the replay never got to it, really.
    const idle = noEffect(original, replay, o);
    if (idle) {
      out[o.id] = unknown(`The step before it, ${idle.description}, changed nothing on screen in the replay (it did the first time), so it can’t tell.`, `الخطوة التي سبقته، ${idle.descriptionAr ?? idle.description}، لم تغيّر شيئًا على الشاشة في الإعادة (وغيّرت في المرة الأولى)، فتعذّر الحكم.`);
      continue;
    }
    // A request the replay sent was still waiting for its answer when it ended: what comes of it wasn't seen yet.
    if (waiting) {
      out[o.id] = unknown(`A request was still waiting for its answer when the replay ended (${waiting.title}), so it can’t tell.`, `كان طلب لا يزال ينتظر إجابته حين انتهت الإعادة (${waiting.titleAr ?? waiting.title})، فتعذّر الحكم.`);
      continue;
    }
    // Not heard as long as it took to show the first time: it may have come after the replay stopped listening.
    const heard = listened(original, replay, o);
    if (heard && heard.heard < heard.lag + 500) {
      out[o.id] = unknown(
        `It came ${secs(heard.lag)} after its step the first time; the replay listened for ${secs(heard.heard)}, so it can’t tell.`,
        `ظهر بعد خطوته بـ${secs(heard.lag)} في المرة الأولى، واستمعت الإعادة ${secs(heard.heard)} فقط، فتعذّر الحكم.`,
      );
      continue;
    }
    if (otherData) {
      out[o.id] = unknown(
        'Couldn’t confirm: the app started from different saved data than when you recorded (its storage or cookies), and it didn’t happen in the replay.',
        'تعذّر التأكيد: بدأ التطبيق من بيانات محفوظة غير التي سجّلت بها (التخزين أو ملفات تعريف الارتباط)، ولم يحدث في الإعادة.',
      );
      continue;
    }
    out[o.id] = fixed('It didn’t happen in the replay.', 'لم يحدث في الإعادة.');
  }
  return out;
}

/**
 * The amounts a finding expects after one of the steps it cites, that the first session never showed (a total of
 * $80.80, not the $86.00 it was worked out from), checked on what the screen showed after the same step in the replay.
 * Null when the finding names no such amount, or the replay has no read of the screen after that step.
 */
export function screenCheck(f: ReportFinding, original: SessionAnalysis, replay: SessionAnalysis): VerifyResult | null {
  const screens = original.screens ?? [];
  const evidence = new Set(f.evidence);
  const at = screens.findIndex((s) => s.diff && !!s.after?.id && evidence.has(s.after.id));
  if (at < 0) return null;
  const step = screens[at].after!.text;
  const cents = (v: number) => Math.round(v * 100);
  const shown = new Set(screens.slice(0, at + 1).flatMap((s) => s.lines.flatMap((l) => amountsIn(l).map((a) => cents(a.value)))));
  const wanted = [...new Map(amountsIn(f.expected ?? '').filter((a) => !shown.has(cents(a.value))).map((a) => [cents(a.value), moneyText(a.value, a.currency)])).values()];
  if (!wanted.length) return null;
  // The same step in the replay: as many times in as in the first session.
  const nth = screens.slice(0, at).filter((s) => s.after?.text === step).length;
  const again = (replay.screens ?? []).filter((s) => s.after?.text === step)[nth];
  if (!again) return null;
  const now = again.lines.filter((l) => !l.startsWith('- ')).join('\n');
  const expected = wanted.join(', ');
  if (wanted.every((w) => showsValue(now, w))) return fixed(`After the same step it shows ${expected} now.`, `بعد الخطوة نفسها يظهر الآن ${expected}.`);
  const appeared = [...new Set(amountsIn(again.lines.filter((l) => l.startsWith('+ ')).join('\n')).map((a) => moneyText(a.value, a.currency)))];
  // Nothing new with an amount: the replay didn't get as far as the result, so it can't tell.
  if (!appeared.length) return null;
  return still(`After the same step it shows ${appeared.slice(0, 4).join(', ')}, not ${expected}.`, `بعد الخطوة نفسها يظهر ${appeared.slice(0, 4).join('، ')} وليس ${expected}.`);
}

/**
 * A finding's verdict from what it rests on: a value checked directly, else an amount it expects on the screen after
 * a step, else its issues (any still there makes it still there).
 */
function verifyFindings(report: SessionReport | null, original: SessionAnalysis, issues: Record<string, VerifyResult>, outcome: ReplayOutcome, replay?: SessionAnalysis): Record<string, VerifyResult> {
  const out: Record<string, VerifyResult> = {};
  if (!report) return out;
  for (const f of report.findings) {
    const check = outcome.checks.find((c) => c.finding === f.id);
    if (check) {
      out[f.id] = checked(check);
      continue;
    }
    const seen = replay ? screenCheck(f, original, replay) : null;
    if (seen) {
      out[f.id] = seen;
      continue;
    }
    const evidence = new Set(f.evidence);
    const related = original.issues.filter((i) => i.evidence.some((e) => evidence.has(e))).map((i) => issues[i.id]).filter(Boolean);
    out[f.id] = related.find((r) => r.verdict === 'still') ?? related.find((r) => r.verdict === 'fixed') ?? related[0] ?? unknown('Nothing in this finding is something a replay can check: try it by hand.', 'لا شيء في هذه الملاحظة تتحقّق منه الإعادة: جرّبها بنفسك.');
  }
  return out;
}

export function verify(original: SessionAnalysis, report: SessionReport | null, replay: SessionAnalysis, outcome: ReplayOutcome, replayId: string): SessionVerification {
  const issues = verifyIssues(original, replay, outcome);
  const known = new Set(original.issues.flatMap(lookFor));
  const fresh = replay.issues
    .filter((r) => r.key && !known.has(normKey(r.key)) && r.kind !== 'said' && r.kind !== 'mark' && r.kind !== 'observed' && !normKey(r.key).startsWith('inp:'))
    .map((r) => ({ title: r.title, titleAr: r.titleAr, kind: r.kind, severity: r.severity }));
  return { at: Date.now(), replay: replayId, steps: outcome.steps, issues, findings: verifyFindings(report, original, issues, outcome, replay), fresh };
}
