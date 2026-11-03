/**
 * Autopilot: the AI uses your app the way a tester would, one step at a time, and says what is wrong. Each turn it
 * sees the page (what it says, what can be done on it), the steps so far and what the app did in response (errors,
 * failed requests), and chooses one next step. The studio carries the step out in the app, recorded as a test
 * session, so the run ends in the usual report, can be replayed, and saved as a test.
 */
import type { PageControl, PageSnapshot, SessionTarget } from '@saywright/vite/protocol';
import { z } from 'zod';
import { STEP_KINDS, describeStep, isRisky, pageStateOf, type StepRecord } from '../shared/autopilot.ts';
import type { JsonRequest } from './ai/service.ts';
import { AgentError } from './ai/types.ts';
import { HttpError, type Router } from './http.ts';
import type { Sessions } from './sessions/index.ts';

export const AutopilotTurn = z.object({
  thought: z.string().describe('One short sentence for the person watching: what you are about to do and why.'),
  action: z.object({
    kind: z.enum(STEP_KINDS),
    control: z.number().int().optional().describe('The number of the control (click, fill, select, check; press, or without one the key goes to the focused control).'),
    value: z
      .string()
      .optional()
      .describe('fill: the text to type. select: the option, as listed. check: "on" or "off". press: the key (Enter, Escape, Tab, ArrowDown). goto: a path in this app, like /settings.'),
  }),
  expect: z.string().optional().describe('What should happen next if the app works.'),
  findings: z
    .array(
      z.object({
        severity: z.enum(['high', 'medium', 'low']),
        title: z.string().describe('The problem in a few words, like a bug report title.'),
        expected: z.string().describe('What should have happened or been shown.'),
        actual: z.string().describe('What the app did or shows instead, quoting it.'),
        control: z.number().int().optional().describe('The control it is about, when there is one.'),
      }),
    )
    .describe('Problems you can see now that are not in the list of problems already reported. Usually empty.'),
  summary: z.string().optional().describe('With done: what you covered and what you found, in one or two sentences.'),
});
export type AutopilotTurn = z.infer<typeof AutopilotTurn>;

export interface TurnInput {
  /** What the person asked for; empty: explore the app's main features. */
  goal: string;
  step: number;
  maxSteps: number;
  /** Whether deleting, paying, sending and signing out are allowed. */
  allowRisky: boolean;
  snapshot: PageSnapshot;
  history: StepRecord[];
  /** What the app did since the last step: errors, failed requests, clicks that did nothing. */
  signals: string[];
  /** Titles of the problems reported so far. */
  reported: string[];
}

const SYSTEM = `You are Saywright Autopilot, a meticulous QA tester using a web app that runs on a developer's computer. You act through numbered controls, one step per turn, and report problems you see.

How to test:
- Work towards the goal. Without a goal, cover the app's main features: its navigation, its main forms and buttons, and what happens with bad input.
- Use the app as a real person would. Fill fields with realistic test data (test@example.com, 4242 4242 4242 4242, a plausible name), never real personal data.
- After the normal path works, try what tends to break: empty or invalid input, unusual values, going back, doing a thing twice.
- Check that what you did took effect where it should show: an item you added is in the cart, a change you saved is there when you come back.
- Check what the app shows against what it should show: totals, counts, messages, states. Do the arithmetic yourself.
- A value you can't know (a coupon code, an account): use one the page or the goal gives; otherwise try a few plausible ones, then move on.
- Never act on controls marked (not allowed). Stay inside this app.
- Never repeat a step on a page that hasn't changed: it can only do the same again. When you are told you have been on this exact page before, do something you haven't done there, or finish with done. If a step fails, try something else.
- Stop with done when the goal is reached, when you have covered the app, or when nothing new can be learned.

Report a finding only for something you can see in the page text or the app's signals (errors, failed requests, clicks that did nothing), never a guess:
- A code, coupon, email, account or other value you made up being rejected is expected: the app doesn't know it. That is not a finding, unless the page itself says the value should work.
- Call a value wrong only when you can show why from the page (the arithmetic, or what the page says elsewhere). A product's description, like “2 × 250 g”, is not a quantity. When the page could be read either way, it is not a finding.
- One finding per problem; never repeat one already reported.`;

const describeControl = (c: PageControl, i: number, allowRisky: boolean, focused: boolean): string => {
  const parts = [`[${i + 1}] ${c.role}`, c.name ? `“${c.name}”` : '(no name)'];
  if (c.field) {
    const f = c.field;
    if (f.type === 'checkbox' || f.type === 'radio') parts.push(f.checked ? '(checked)' : '(not checked)');
    else parts.push(`${f.type}, holds “${f.value}”`);
    if (f.options) parts.push(`options: ${f.options.map((o) => `“${o}”`).join(', ')}`);
    if (f.required) parts.push('required');
  }
  if (c.disabled) parts.push('(disabled)');
  if (c.offscreen) parts.push('(below or above the visible part)');
  if (focused) parts.push('(focused)');
  if (!allowRisky && isRisky(c.name)) parts.push('(not allowed)');
  return parts.join(' ');
};

/** The steps already taken on this exact page, each with how often: doing one again does the same again. */
function doneHere(input: TurnInput): Map<string, number[]> {
  const here = pageStateOf(input.snapshot);
  const out = new Map<string, number[]>();
  for (const h of input.history) if (h.page === here) out.set(h.did, [...(out.get(h.did) ?? []), h.n]);
  return out;
}

/** The turn's prompt: the goal, the page as Autopilot sees it, the steps so far and what the app did. */
export function turnPrompt(input: TurnInput): { system: string; text: string } {
  const s = input.snapshot;
  const again = doneHere(input);
  const lines = [
    `Goal: ${input.goal.trim() || 'Explore the app and find problems in its main features.'}`,
    `Step ${input.step} of at most ${input.maxSteps}.`,
    '',
    `Page: ${s.title ? `“${s.title}” ` : ''}${s.url}`,
    s.dialog ? `A dialog is open: “${s.dialog}”. Only its controls are listed.` : '',
    s.headings.length ? `Headings: ${s.headings.map((h) => `“${h}”`).join(' · ')}` : '',
    `Text on the page: ${s.text || '(none)'}`,
    '',
    'Controls:',
    ...s.controls.map((c, i) => describeControl(c, i, input.allowRisky, s.focused === i)),
    s.more ? `(${s.more} more not listed: scroll to reach them)` : '',
    '',
    input.history.length ? `Steps so far:\n${input.history.map((h) => `${h.n}. ${h.did}${h.ok ? '' : ` — failed: ${h.error ?? 'unknown'}`}${h.url !== s.url ? ` (then at ${h.url})` : ''}`).join('\n')}` : 'No steps yet.',
    again.size
      ? `You have been on this exact page before. Here you already: ${Array.from(again)
          .map(([did, at]) => `${did} (step ${at.join(', ')})`)
          .join('; ')}. Doing that again only does the same again: do something else, or finish with done.`
      : '',
    input.signals.length ? `What the app did after the last step:\n${input.signals.map((x) => `- ${x}`).join('\n')}` : 'The app reported no errors after the last step.',
    input.reported.length ? `Problems already reported: ${input.reported.map((r) => `“${r}”`).join('; ')}` : '',
  ];
  return { system: SYSTEM, text: lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n') };
}

/** Times the same step on the same page may come back: once to see that it happens again (doing a thing twice). */
const REPEATS = 2;

/**
 * Ask for the next step. A key press without a control goes to the focused one (or the page). A step taken twice
 * already on this same page is asked again once with that said, and ends the run if it comes back. A step that
 * names a control that isn't listed comes back as done, with why.
 */
export async function nextTurn(input: TurnInput, ask: <T>(req: JsonRequest<T>) => Promise<{ value: T; model: string }>, signal?: AbortSignal): Promise<{ turn: AutopilotTurn; model: string }> {
  const { system, text } = turnPrompt(input);
  const choose = async (note = '') => {
    // The same system prompt every turn: cached. Each turn's page is new: not.
    const { value, model } = await ask({ task: 'report', feature: 'autopilot', system, parts: [{ type: 'text', text: text + note }], schema: AutopilotTurn, name: 'autopilot_step', maxTokens: 1200, effort: 'low', signal, cache: 'system' });
    const turn = { ...value, findings: (value.findings ?? []).slice(0, 3) };
    const focused = input.snapshot.focused;
    if (turn.action.kind === 'press' && turn.action.control === undefined && focused != null && focused < input.snapshot.controls.length) turn.action = { ...turn.action, control: focused + 1 };
    return { turn, model };
  };
  const repeated = (turn: AutopilotTurn) => {
    const c = turn.action.control;
    const did = describeStep(turn.action, c ? input.snapshot.controls[c - 1] : undefined);
    return { did, at: doneHere(input).get(did) ?? [] };
  };

  let { turn, model } = await choose();
  let again = repeated(turn);
  if (turn.action.kind !== 'done' && again.at.length >= REPEATS) {
    const first = turn;
    ({ turn, model } = await choose(`\n\nYou chose: ${again.did}. You already did exactly that on this same page (step ${again.at.join(', ')}), and it came back to the same page. Choose a different step, or finish with done if there is nothing new to try here.`));
    turn = { ...turn, findings: [...first.findings, ...turn.findings.filter((f) => !first.findings.some((g) => g.title === f.title))].slice(0, 3) };
    again = repeated(turn);
    if (turn.action.kind !== 'done' && again.at.length >= REPEATS) {
      return { turn: { ...turn, action: { kind: 'done' }, summary: turn.summary ?? `Stopped: it kept choosing “${again.did}” on a page that didn’t change.` }, model };
    }
  }
  const needsControl = ['click', 'fill', 'select', 'check'].includes(turn.action.kind);
  const c = turn.action.control;
  if ((needsControl && c === undefined) || (c !== undefined && (c < 1 || c > input.snapshot.controls.length))) {
    return { turn: { ...turn, action: { kind: 'done' }, summary: turn.summary ?? `Stopped: the AI chose a control that isn't on the page (${c ?? 'none'}).` }, model };
  }
  return { turn, model };
}

// ---- the route ------------------------------------------------------------------------------------------------

const Control = z.object({
  locator: z.string().max(400),
  role: z.string().max(40),
  name: z.string().max(120),
  field: z
    .object({ type: z.string().max(30), value: z.string().max(200), required: z.boolean(), checked: z.boolean().optional(), options: z.array(z.string().max(80)).max(30).optional() })
    .optional(),
  disabled: z.boolean(),
  offscreen: z.boolean(),
  src: z.string().max(400).nullable(),
});

const TurnRequest = z.object({
  session: z.string().max(80),
  goal: z.string().max(500),
  step: z.number().int().min(1).max(200),
  maxSteps: z.number().int().min(1).max(200),
  allowRisky: z.boolean(),
  /** When the last step was taken (Date.now() time): what went wrong since then is told to the AI. */
  since: z.number(),
  snapshot: z.object({
    url: z.string().max(2000),
    title: z.string().max(300),
    headings: z.array(z.string().max(200)).max(20),
    text: z.string().max(4000),
    controls: z.array(Control).max(80),
    more: z.number().int().min(0),
    dialog: z.string().max(200).nullable(),
    viewport: z.tuple([z.number(), z.number()]),
    focused: z.number().int().min(0).nullable().optional(),
  }),
  history: z.array(z.object({ n: z.number().int(), did: z.string().max(300), ok: z.boolean(), error: z.string().max(200).optional(), url: z.string().max(2000), page: z.string().max(40).optional() })).max(200),
  reported: z.array(z.string().max(200)).max(50),
});

interface AutopilotDeps {
  sessions: (id: string) => Sessions;
  /** How to ask the AI for a turn (the test double in tests); null when no AI is connected for reports. */
  ask: (input: TurnInput) => (<T>(req: JsonRequest<T>) => Promise<{ value: T; model: string }>) | null;
  /** Throws when the AI budget says stop. */
  gate?: () => void;
}

/** What a control was, for the session's report: its place in the code and the locator that finds it. */
const targetOf = (c: PageControl): SessionTarget => ({ src: c.src, name: c.role, tag: c.role, role: c.role, label: c.name.slice(0, 60), text: c.name.slice(0, 80), locator: c.locator, rect: [0, 0, 0, 0] });

/** The AI's refusal as the studio's other AI routes answer it: the budget is 402, a missing key 409. */
export function aiHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const e = err instanceof AgentError ? err : new AgentError(err instanceof Error ? err.message : String(err), 'other');
  return new HttpError(e.code === 'budget' ? 402 : e.code === 'auth' || e.code === 'no-key' ? 409 : 502, e.message, e.code);
}

/** Before the first page is read: only whether an AI is there to ask. */
const NO_PAGE: TurnInput = { goal: '', step: 1, maxSteps: 1, allowRisky: false, snapshot: { url: '', title: '', headings: [], text: '', controls: [], more: 0, dialog: null, viewport: [0, 0] }, history: [], signals: [], reported: [] };

export function autopilotRoutes(router: Router, deps: AutopilotDeps): void {
  const askFor = (input: TurnInput) => {
    const ask = deps.ask(input);
    if (!ask) throw new HttpError(409, 'Autopilot needs an AI. Connect one in Settings → AI.', 'needs-ai');
    return ask;
  };

  // Before a run's session is created, so a run that can't start leaves no empty session behind.
  router.post('/autopilot/ready', () => {
    askFor(NO_PAGE);
    try {
      deps.gate?.();
    } catch (err) {
      throw aiHttpError(err);
    }
    return { ok: true };
  });

  router.post('/autopilot/turn', async (req) => {
    const parsed = TurnRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, `Not an Autopilot turn: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    const { session, since, ...rest } = parsed.data;
    const sessions = deps.sessions(session);
    const meta = sessions.store.meta(session);
    if (meta.source !== 'autopilot' || meta.status !== 'recording') throw new HttpError(409, 'This Autopilot run has ended.');
    const input: TurnInput = { ...rest, history: rest.history.slice(-25), signals: sessions.notableSince(session, since) };
    const { turn, model } = await nextTurn(input, askFor(input)).catch((err: unknown) => {
      throw aiHttpError(err);
    });
    const now = Date.now();
    const control = turn.action.control ? input.snapshot.controls[turn.action.control - 1] : undefined;
    if (turn.action.kind !== 'done') sessions.studioEvent(session, { type: 'autopilot', did: describeStep(turn.action, control), why: turn.thought.slice(0, 300), t: now });
    for (const f of turn.findings) {
      const about = f.control ? input.snapshot.controls[f.control - 1] : undefined;
      sessions.studioEvent(session, { type: 'observed', severity: f.severity, title: f.title.slice(0, 160), expected: f.expected.slice(0, 400), actual: f.actual.slice(0, 400), el: about ? targetOf(about) : null, t: now });
    }
    return { turn, model, signals: input.signals };
  });
}
