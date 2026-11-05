/**
 * Replay & verify. After a fix, a session's steps are played again in the
 * app, in the studio's own frame (so with the tester's logins and data), the
 * way the tester did them: each target is shown, then clicked, filled or
 * pressed. The replay is recorded as a session of its own; the studio server
 * compares it with the first one, problem by problem. Values the tester said
 * something should show ("the total should be $80.80") are read in the app at
 * the moment they were said.
 */
import type { ElementInfo } from '@saywright/vite/protocol';
import type { ReplayCheck, ReplayOutcome, ReportFinding, SessionAnalysis, SessionDetail, SessionStep, SessionTarget, TranscriptSegment } from '@shared/session';
import { amountsIn, moneyText, saidAt, saidValue, showsValue } from '@shared/expected';
import { api } from '@/lib/api';
import type { BridgeClient } from './bridge';
import { evidenceItems } from './evidence';

export interface ReplayView {
  /** The session being replayed. */
  id: string;
  name: string;
  phase: 'starting' | 'playing' | 'finishing';
  step: number;
  total: number;
  description: string;
  /** What the step is about to act on (shown in the app). */
  target: ElementInfo | null;
}

interface ReplayHost {
  bridge: BridgeClient;
  connected(): boolean;
  /** How many times the app has connected so far (each page load is one). */
  connections(): number;
  /** The app's address now. */
  appUrl(): string;
  enterUse(): () => void;
  show(view: ReplayView | null): void;
  /** Where the step's target is, in window coordinates (for the cursor), or null. */
  point(el: ElementInfo | null, acting: boolean): void;
  openReport(id: string): void;
  notify(text: string): void;
}

/** A value to read in the app once the replay has reached the moment it was said. */
interface PlannedCheck {
  finding?: string;
  issue?: string;
  expected: string;
  locator: string;
  like?: SessionStep['like'];
  t: number;
  /** The element it is read on, as the session recorded it. */
  el: SessionTarget;
}

/** What an element was, when its locator goes by its place in the code (a fix can move it). */
const likeOf = (el: SessionTarget): SessionStep['like'] => (el.locator?.startsWith('page.locator(\'[data-ds-src=') ? { tag: el.tag, name: el.name, text: el.text, ...(el.shape ? { shape: el.shape } : {}) } : undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Check = Omit<PlannedCheck, 'finding' | 'issue'>;

/** What a sentence says something should show, to read on what was pointed at while it was said, at that moment. */
function saidCheck(seg: TranscriptSegment | undefined, el: SessionTarget | null | undefined): Check | null {
  if (!seg || !el?.locator) return null;
  const said = saidValue(seg.text);
  return said ? { expected: said.expected, locator: el.locator, like: likeOf(el), t: saidAt(seg, said), el } : null;
}

/** The values the replay can check, and when: from the sentences that complained and the report's findings. */
export function plannedChecks(d: SessionDetail): PlannedCheck[] {
  const a = d.analysis;
  if (!a) return [];
  const out: PlannedCheck[] = [];
  for (const issue of a.issues) {
    if (issue.kind !== 'said') continue;
    const check = saidCheck(a.transcript.find((s) => s.start === issue.t), issue.el);
    if (check) out.push({ issue: issue.id, ...check });
  }
  for (const f of d.report?.findings ?? []) {
    const check = findingCheck(f, a);
    if (check) out.push({ finding: f.id, ...check });
  }
  return out;
}

/**
 * What a finding says something should show, and on what: what the tester said while pointing at it (their own
 * words, read on the element they were said about), else the value the finding expects, when it names one.
 */
export function findingCheck(f: ReportFinding, a: SessionAnalysis): Check | null {
  const items = evidenceItems(f, a);
  for (const it of items) {
    const seg = it.kind === 'speech' ? a.transcript.find((s) => s.start === it.t) : undefined;
    const check = saidCheck(seg, seg?.el);
    if (check) return check;
  }
  // Read when the problem showed on it: not at the finding's last evidence, which can be much later (a payment made).
  for (const { el, t } of targetsOf(items, a)) {
    const expected = el.locator ? expectedOf(f, el) : null;
    if (el.locator && expected) return { expected, locator: el.locator, like: likeOf(el), t, el };
  }
  return null;
}

/**
 * For a test of a finding whose evidence names no element with the value: an element of the session the finding's
 * expected value is named after (“a total of $80.80” and the Total row pointed at), nearest the problem.
 */
export function namedCheck(f: ReportFinding, a: SessionAnalysis): Check | null {
  const at = evidenceItems(f, a)[0]?.t ?? Infinity;
  const all = [...a.transcript.map((s) => ({ el: s.el, t: s.start })), ...a.issues.map((g) => ({ el: g.el, t: g.t }))].filter((x): x is { el: SessionTarget; t: number } => !!x.el?.locator);
  const near = all.sort((x, y) => Math.abs(x.t - at) - Math.abs(y.t - at));
  for (const { el, t } of near) {
    const expected = namedValue(f.expected ?? '', el);
    if (expected) return { expected, locator: el.locator!, like: likeOf(el), t, el };
  }
  return null;
}

/** The value a finding expects: from the tester's words it quotes, else its only amount, or the one named like the element (“total $80.80” on the Total row). */
function expectedOf(f: ReportFinding, target: SessionTarget): string | null {
  const said = saidValue(f.quote ?? '');
  if (said) return said.expected;
  const amounts = amountsIn(f.expected ?? '');
  if (amounts.length === 1) return moneyText(amounts[0].value, amounts[0].currency);
  return namedValue(f.expected ?? '', target);
}

/** The amount in `expected` named like the element, in the words just before it (“total $80.80” for the Total row). */
function namedValue(expected: string, target: SessionTarget): string | null {
  const words = (target.label || target.text).toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const named = amountsIn(expected).find((m) => words.some((w) => expected.toLowerCase().slice(Math.max(0, m.index - 24), m.index).includes(w)));
  return named ? moneyText(named.value, named.currency) : null;
}

/** The elements a finding is about, with when: what was pointed at while saying it, or what the problem happened on. */
function targetsOf(items: { kind: string; t: number; issue?: string }[], a: SessionAnalysis): { el: SessionTarget; t: number }[] {
  const out: { el: SessionTarget; t: number }[] = [];
  for (const it of items) {
    const seg = it.kind === 'speech' ? a.transcript.find((s) => s.start === it.t) : null;
    const issue = it.issue ? a.issues.find((g) => g.id === it.issue) : null;
    const el = seg?.el ?? issue?.el;
    if (el && !out.some((o) => o.el.src === el.src && o.el.label === el.label)) out.push({ el, t: it.t });
  }
  return out;
}

export class Replayer {
  running: string | null = null;
  private stopped = false;

  constructor(private host: ReplayHost) {}

  /** Stop where it is: what was played so far is still compared. */
  stop(): void {
    this.stopped = true;
  }

  private async connected(ms: number): Promise<boolean> {
    const until = performance.now() + ms;
    while (!this.host.connected()) {
      if (performance.now() > until) return false;
      await sleep(100);
    }
    return true;
  }

  /** Find a step's target, giving the app a moment to show it (a page loading, a menu opening). */
  private async locate(locator: string, like?: SessionStep['like'], ms = 6000): Promise<{ info: ElementInfo | null; error?: string }> {
    const until = performance.now() + ms;
    let error = 'missing';
    for (;;) {
      if (await this.connected(5000)) {
        // Short asks: a page that is loading (after a click that navigates) doesn't answer.
        const r = await this.host.bridge.replay(locator, undefined, false, like, 1500);
        if (r.ok && r.info) return { info: r.info };
        error = r.error ?? error;
        if (error === 'unreadable') return { info: null, error };
      } else error = 'disconnected';
      if (performance.now() > until || this.stopped) return { info: null, error };
      await sleep(250);
    }
  }

  /**
   * What the element a value was said about shows now (null: it isn't there). It may still be on its way (a total
   * worked out again after a click), so it is read again for a moment before it is called wrong.
   */
  private async read(c: Check): Promise<{ actual: string | null; ok: boolean }> {
    const until = performance.now() + 1500;
    for (;;) {
      const r = (await this.connected(3000)) ? await this.host.bridge.replay(c.locator, undefined, true, c.like) : null;
      const actual = r?.ok ? (r.text ?? '') : null;
      const ok = actual !== null && showsValue(actual, c.expected);
      if (ok || performance.now() > until || this.stopped) return { actual, ok };
      await sleep(250);
    }
  }

  async run(d: SessionDetail): Promise<void> {
    const a = d.analysis;
    if (!a || this.running) return;
    this.running = d.meta.id;
    this.stopped = false;
    const steps = a.steps.filter((s): s is SessionStep & { locator: string } => s.kind !== 'navigate' && !!s.locator);
    const plan = plannedChecks(d).sort((x, y) => x.t - y.t);
    const checks: ReplayCheck[] = [];
    const view: ReplayView = { id: d.meta.id, name: d.meta.name, phase: 'starting', step: 0, total: steps.length, description: 'Opening the page the session started on', target: null };
    this.host.show({ ...view });
    let replayId: string | null = null;
    let restore: (() => void) | null = null;
    let done = 0;
    let failed: ReplayOutcome['steps']['failed'];
    try {
      // From where the session started, fresh.
      const start = a.steps.find((s) => s.kind === 'navigate')?.url ?? a.pages[0]?.url ?? d.meta.appUrl;
      const here = new URL(this.host.appUrl() || start);
      const from = new URL(start, here);
      const loads = this.host.connections();
      this.host.bridge.goto(`${here.origin}${from.pathname}${from.search}${from.hash}`);
      const until = performance.now() + 15_000;
      while (!(this.host.connections() > loads && this.host.connected())) {
        if (performance.now() > until) throw new Error('Your app didn’t load again: is it still running?');
        if (this.stopped) throw new Error('stopped');
        await sleep(100);
      }
      // Its first render and requests.
      await sleep(700);

      const { session, key } = await api.post<{ session: { id: string }; key: string }>('/sessions', { name: `Replay of ${d.meta.name}`.slice(0, 120), appUrl: this.host.appUrl(), source: 'replay', replayOf: d.meta.id, lang: d.meta.lang });
      replayId = session.id;
      // Without the app recording it, there would be nothing to compare (and everything would look fixed).
      if (!(await this.host.bridge.session(true, replayId, location.origin, key))) throw new Error('not-recording');
      restore = this.host.enterUse();
      // Secrets the session typed (never recorded): typed again from what you saved for them, or the replay stops there.
      const names = [...new Set(steps.flatMap((s) => (s.secret ? [s.secret] : [])))];
      const secrets: Record<string, string> = names.length ? ((await api.post<{ values: Record<string, string> }>('/tests/secrets/values', { names }).catch(() => ({ values: {} as Record<string, string> }))).values ?? {}) : {};

      let next = 0;
      const checkUpTo = async (t: number) => {
        while (next < plan.length && plan[next].t <= t) {
          const c = plan[next++];
          // A finding about what was said is read once with the sentence it rests on.
          const same = checks.find((x, i) => plan[i].locator === c.locator && plan[i].t === c.t && x.expected === c.expected);
          const { actual, ok } = same ?? (await this.read(c));
          checks.push({ finding: c.finding, issue: c.issue, expected: c.expected, actual, ok });
        }
      };
      for (let i = 0; i < steps.length; i++) {
        if (this.stopped) {
          failed = { i, t: steps[i].t, description: steps[i].description, descriptionAr: steps[i].descriptionAr, reason: 'stopped' };
          break;
        }
        const s = steps[i];
        // What was said before this step was said about the screen as it was then.
        await checkUpTo(s.t);
        Object.assign(view, { phase: 'playing', step: i + 1, description: s.description, target: null });
        this.host.show({ ...view });
        const found = await this.locate(s.locator, s.like);
        if (!found.info) {
          failed = { i, t: s.t, description: s.description, descriptionAr: s.descriptionAr, reason: found.error ?? 'missing' };
          break;
        }
        view.target = found.info;
        this.host.show({ ...view });
        this.host.point(found.info, false);
        await sleep(450);
        const value = s.secret ? secrets[s.secret.toUpperCase()] : s.value;
        if (s.secret && !value) {
          failed = { i, t: s.t, description: s.description, descriptionAr: s.descriptionAr, reason: 'secret' };
          break;
        }
        const r = await this.host.bridge.replay(s.locator, { kind: s.kind as 'click' | 'fill' | 'press', value, key: s.key, checked: s.checked, select: s.select }, false, s.like);
        if (!r.ok) {
          failed = { i, t: s.t, description: s.description, descriptionAr: s.descriptionAr, reason: r.error ?? 'failed' };
          break;
        }
        this.host.point(found.info, true);
        done++;
        // What it did may move or remove the target: the box goes, the pointer stays where it clicked.
        view.target = null;
        this.host.show({ ...view });
        // As long as the tester waited before the next step (within reason): the app's response arrives meanwhile.
        const gap = steps[i + 1] ? steps[i + 1].t - s.t : 1200;
        await sleep(Math.max(500, Math.min(1800, gap)));
      }
      if (!failed) await checkUpTo(Infinity);
      Object.assign(view, { phase: 'finishing', description: 'Comparing with the session', target: null });
      this.host.show({ ...view });
      this.host.point(null, false);
      // Errors and requests that come a moment after the last step.
      await sleep(1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Where it stopped: what comes after can't be judged.
      const s = steps[done];
      if (!failed && s) failed = { i: done, t: s.t, description: s.description, descriptionAr: s.descriptionAr, reason: message === 'stopped' || message === 'not-recording' ? message : 'error' };
      if (message !== 'stopped') this.host.notify(message === 'not-recording' ? 'The replay couldn’t run: your app didn’t start recording it.' : `The replay couldn’t run: ${message}`);
    } finally {
      if (replayId) {
        await this.host.bridge.session(false);
        await api.post(`/sessions/${replayId}/stop`, {}).catch(() => undefined);
        const outcome: ReplayOutcome = { steps: { total: steps.length, done, failed }, checks };
        await api.put(`/sessions/${d.meta.id}/verify`, { replay: replayId, outcome }).catch(() => undefined);
      }
      restore?.();
      this.host.show(null);
      this.host.point(null, false);
      this.running = null;
      if (replayId) this.host.openReport(d.meta.id);
    }
  }
}
