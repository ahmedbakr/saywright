/**
 * Autopilot in the studio: the AI uses the app in the studio's frame, one step at a time, recorded as a test session
 * (the server side is server/autopilot.ts). Each turn the page is read through the bridge, the server asks the AI for
 * the next step, and the step is carried out the way a replayed one is: shown, then clicked, filled or pressed.
 */
import type { ElementInfo, PageSnapshot } from '@saywright/vite/protocol';
import { describeStep, pageStateOf, riskOf, type AutopilotAction, type StepRecord } from '@shared/autopilot';
import { api } from '@/lib/api';
import type { BridgeClient } from './bridge';

export interface AutopilotOptions {
  /** What to try; empty: explore the app's main features. */
  goal: string;
  maxSteps: number;
  /** Let it delete, pay, send and sign out. */
  allowRisky: boolean;
}

export interface AutopilotView {
  phase: 'starting' | 'thinking' | 'acting' | 'finishing';
  goal: string;
  step: number;
  total: number;
  /** What it is doing, in its own words. */
  description: string;
  /** Problems seen so far. */
  found: number;
}

export interface AutopilotHost {
  bridge: BridgeClient;
  connected(): boolean;
  /** How many times the app has connected so far (each page load is one). */
  connections(): number;
  appUrl(): string;
  enterUse(): () => void;
  show(view: AutopilotView | null): void;
  point(el: ElementInfo | null, acting: boolean): void;
  openReport(id: string): void;
  notify(text: string): void;
}

interface Turn {
  thought: string;
  action: AutopilotAction;
  findings: { title: string }[];
  summary?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Failed steps in a row after which the run ends: the AI is stuck. */
const MAX_FAILURES = 3;

export class Autopilot {
  running = false;
  private stopped = false;

  constructor(private host: AutopilotHost) {}

  stop(): void {
    this.stopped = true;
  }

  private async connected(ms: number): Promise<boolean> {
    const until = performance.now() + ms;
    while (!this.host.connected()) {
      if (performance.now() > until || this.stopped) return false;
      await sleep(100);
    }
    return true;
  }

  /** The page as it is now; null when the app doesn't answer for a while. */
  private async look(): Promise<PageSnapshot | null> {
    for (let i = 0; i < 4 && !this.stopped; i++) {
      if (await this.connected(5000)) {
        const s = await this.host.bridge.explore();
        if (s) return s;
      }
      await sleep(500);
    }
    return null;
  }

  /** Carry a step out in the app. */
  private async act(action: AutopilotAction, page: PageSnapshot, previous: string | null, opts: AutopilotOptions): Promise<{ ok: boolean; error?: string; why?: string }> {
    const control = action.control ? page.controls[action.control - 1] : undefined;
    const origin = new URL(page.url).origin;
    // The server marks these for the AI; this is the guarantee (and the page refuses the rest: bridge/guard.ts).
    const why = opts.allowRisky ? null : riskOf(action, control, page.url);
    if (why) return { ok: false, error: 'not allowed', why };
    // Without leave, every step that acts in the page has the page refuse what would delete, pay, send or sign out.
    const guard = !opts.allowRisky;
    switch (action.kind) {
      case 'click':
      case 'fill':
      case 'select':
      case 'check':
      case 'press': {
        // A key with no control in focus goes to the page (Escape closes a menu, a shortcut runs).
        if (action.kind === 'press' && !control) {
          const r = await this.host.bridge.replay("page.locator('body')", { kind: 'press', key: action.value || 'Enter', guard }, false, undefined, 4000);
          return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'failed' };
        }
        if (!control) return { ok: false, error: 'not on the page' };
        const shown = await this.host.bridge.replay(control.locator, undefined, false, undefined, 2500);
        if (!shown.ok || !shown.info) return { ok: false, error: shown.error ?? 'missing' };
        this.host.point(shown.info, false);
        await sleep(400);
        // Stop takes effect before the next action, even one already shown.
        if (this.stopped) return { ok: false, error: 'stopped' };
        const step =
          action.kind === 'click'
            ? { kind: 'click' as const }
            : action.kind === 'press'
              ? { kind: 'press' as const, key: action.value || 'Enter' }
              : action.kind === 'check'
                ? { kind: 'fill' as const, checked: action.value !== 'off' }
                : { kind: 'fill' as const, value: action.value ?? '' };
        if (guard) Object.assign(step, { guard });
        const r = await this.host.bridge.replay(control.locator, step, false, undefined, 4000);
        this.host.point(shown.info, true);
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'failed' };
      }
      case 'scroll': {
        // From the middle of the page: what scrolls there is what holds the content (the page, or a panel in it).
        const [w, h] = page.viewport;
        this.host.bridge.scroll(w / 2, h / 2, 0, Math.round(h * 0.8));
        return { ok: true };
      }
      case 'back':
        if (!previous) return { ok: false, error: 'no page before this one' };
        this.host.bridge.goto(previous);
        return { ok: true };
      case 'goto': {
        const to = new URL(action.value || '/', page.url);
        if (to.origin !== origin) return { ok: false, error: 'outside the app' };
        this.host.bridge.goto(to.href);
        return { ok: true };
      }
      case 'done':
        return { ok: true };
    }
  }

  /** A step left alone, in the session's timeline with why. */
  private skipped(session: string | null, did: string): void {
    if (!session) return;
    const event = { type: 'autopilot', did, why: 'Not allowed: “Let it delete, pay, send and sign out” is off.', t: Date.now(), seq: Date.now() * 100 + Math.floor(Math.random() * 100) };
    void api.post(`/sessions/${session}/studio-events`, { events: [event] }).catch(() => undefined);
  }

  async run(opts: AutopilotOptions): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const view: AutopilotView = { phase: 'starting', goal: opts.goal, step: 0, total: opts.maxSteps, description: 'Starting a test session', found: 0 };
    this.host.show({ ...view });
    let session: string | null = null;
    let restore: (() => void) | null = null;
    const history: StepRecord[] = [];
    const reported: string[] = [];
    const visited: string[] = [];
    let failures = 0;
    let since = Date.now();
    let failed = false;
    let refusedBy: { n: number; page: PageSnapshot } | null = null;
    const refused = (list: string[] | undefined) => {
      for (const what of refusedBy ? (list ?? []) : []) {
        const did = `Stopped in the page: ${what} (not allowed)`;
        this.skipped(session, did);
        history.push({ n: refusedBy!.n, did, ok: false, error: 'not allowed', url: this.host.appUrl() || refusedBy!.page.url, page: pageStateOf(refusedBy!.page) });
      }
    };
    try {
      // An AI to drive it, within the budget, before there is a session: a run that can't start leaves none behind.
      await api.post('/autopilot/ready', {});
      const started = await api.post<{ session: { id: string }; key: string }>('/sessions', { name: (opts.goal ? `Autopilot: ${opts.goal}` : 'Autopilot').slice(0, 120), appUrl: this.host.appUrl(), source: 'autopilot', lang: 'en', replace: true });
      session = started.session.id;
      if (!(await this.host.bridge.session(true, session, location.origin, started.key))) throw new Error('not-recording');
      restore = this.host.enterUse();
      for (let n = 1; n <= opts.maxSteps && !this.stopped; n++) {
        Object.assign(view, { phase: 'thinking', step: n, description: n === 1 ? 'Reading the page' : view.description });
        this.host.show({ ...view });
        const page = await this.look();
        if (!page) throw new Error('Your app stopped answering: is it still running?');
        // What the page refused after the last look (a request the last step started late).
        refused(page.blocked);
        if (visited[visited.length - 1] !== page.url) visited.push(page.url);
        const { turn } = await api.post<{ turn: Turn }>('/autopilot/turn', { session, goal: opts.goal, step: n, maxSteps: opts.maxSteps, allowRisky: opts.allowRisky, since, snapshot: page, history, reported });
        reported.push(...turn.findings.map((f) => f.title));
        Object.assign(view, { phase: 'acting', description: turn.thought, found: reported.length });
        this.host.show({ ...view });
        if (turn.action.kind === 'done' || this.stopped) break;
        const loads = this.host.connections();
        since = Date.now();
        const control = turn.action.control ? page.controls[turn.action.control - 1] : undefined;
        const r = this.stopped ? { ok: false, error: 'stopped' } : await this.act(turn.action, page, visited[visited.length - 2] ?? null, opts);
        if (r.error === 'stopped') break;
        // The app's response: a new page (it reconnects) or what the step changed on this one.
        await sleep(900);
        if (this.host.connections() !== loads) await this.connected(10_000);
        const sends = turn.action.kind === 'press' && control?.submits ? `pressing Enter in “${control.name}”, which sends the form with “${control.submits}”` : null;
        const what = sends ?? (turn.action.kind === 'goto' ? `opening ${turn.action.value ?? '/'}` : control ? `“${control.name || control.role}”` : 'a control');
        const did = r.error === 'not allowed' ? `Skipped ${what} (not allowed: ${r.why})` : describeStep(turn.action, control);
        // In the timeline too: the run's report says what it left alone, and why.
        if (r.error === 'not allowed') this.skipped(session, did);
        history.push({ n, did, ok: r.ok, ...(r.error ? { error: r.error } : {}), url: this.host.appUrl() || page.url, page: pageStateOf(page) });
        // What the page itself refused while the step played out (a delete request, a sign-out address, a “confirm”).
        refusedBy = { n, page };
        refused((await this.host.bridge.explore())?.blocked);
        failures = r.ok ? 0 : failures + 1;
        if (failures >= MAX_FAILURES) {
          this.host.notify('Autopilot stopped: its last steps didn’t work.');
          break;
        }
      }
      Object.assign(view, { phase: 'finishing', description: 'Writing the report' });
      this.host.show({ ...view });
      this.host.point(null, false);
      // Errors and requests that come a moment after the last step.
      await sleep(1000);
    } catch (err) {
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      this.host.notify(message === 'not-recording' ? 'Autopilot couldn’t start: your app didn’t start recording.' : `Autopilot ${session && history.length ? 'stopped' : 'couldn’t start'}: ${message}`);
    } finally {
      // A run that failed before its first step has nothing to report: its session goes.
      const empty = failed && !history.length;
      if (session) {
        await this.host.bridge.session(false);
        await api.post(`/sessions/${session}/stop`, {}).catch(() => undefined);
        if (empty) await api.delete(`/sessions/${session}`).catch(() => undefined);
      }
      restore?.();
      this.host.show(null);
      this.host.point(null, false);
      this.running = false;
      if (session && !empty) this.host.openReport(session);
    }
  }
}
