/**
 * The usage benchmark: what developers do with Saywright, journey by journey, on projects of different kinds. Each
 * project is in projects/<name>, with a usage.json saying what to do with it. `npm run eval:usage`; free unless
 * EVAL_AI=real (then EVAL_BUDGET, in dollars, default 2, stops the AI journeys).
 *
 *   point     the mouse on an element: the studio names its source (file and line) as the manifest says
 *   edit      a quick edit said with the element selected: the file changes as expected, the app still shows it
 *             without an error, and undo puts the file back byte for byte
 *   test      Write test from a use and a value: generated and run EVAL_RUNS times (default 2). On a bug it fails at
 *             its check; on a correct app it passes, verified. A secret typed is never in the test
 *   session   a recorded session of a use: its steps, errors and failed requests are in it, and secrets aren't
 *             anywhere in its files
 *   replay    Replay & verify on a session that ran into a problem: still happening before the fix, fixed after
 *   experts   a review of a page reports the rules the manifest names
 *   mcp       a coding agent's calls: what is selected, a file (and not one outside the project), a search, and a
 *             change it proposes, shown in the studio and undone
 *   ai        with a real AI: a change asked for in words, and what must hold after it
 *
 * Every result is kept, with its time, in .saywright/usage-eval/: the summary has a line per journey and project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { openStudio, store } from '../../e2e/helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../../..');
const WORK = path.resolve(here, '../../.usage-work');
const STUDIO = `http://localhost:${process.env.EVAL_STUDIO_PORT || 5473}`;
const RUNS = Number(process.env.EVAL_RUNS || 2);
const AI = process.env.EVAL_AI === 'real';
const BUDGET = Number(process.env.EVAL_BUDGET || 2);
const OUT = path.join(ROOT, '.saywright', 'usage-eval');
// oxlint-disable-next-line no-control-regex -- the escape character starts the terminal's colour codes
const ANSI = /\x1b\[[0-9;]*m/g;

/** An element of the app, as Playwright finds it (`nth` when there are several). */
type Target = ({ testId: string } | { role: string; name: string } | { label: string } | { text: string }) & { nth?: number };
interface Step {
  do: 'fill' | 'select' | 'check' | 'uncheck' | 'click' | 'press' | 'goto' | 'wait';
  target?: Target;
  value?: string;
  /** Every option to choose in a list that takes several. */
  values?: string[];
  /** The value is a secret: it must never be written anywhere. */
  secret?: boolean;
}
interface Manifest {
  name: string;
  about: string;
  stack: string;
  points?: { target: Target; src: string; path?: string }[];
  edits?: { target: Target; say: string; file: string; contains: string; path?: string }[];
  tests?: { name: string; path?: string; flow: Step[]; check: { target: Target; expected: string }; secrets?: Record<string, string>; bug: boolean }[];
  sessions?: { name: string; path?: string; flow: Step[]; expect: { steps?: number; errors?: number; failedRequests?: number } }[];
  experts?: { path?: string; expect: string[] }[];
  /** Replay & verify: a session of a use that runs into `finding`, replayed before the fix and after it. */
  replays?: { name: string; path?: string; flow: Step[]; finding: string; break?: Patch; fix?: Patch }[];
  mcp?: { search: string; read: string };
  ai?: { name: string; target: Target; say: string; path?: string; then: Step[] }[];
}
/** A change to a project's file: `find`, exactly once, becomes `replace`. */
interface Patch {
  file: string;
  find: string;
  replace: string;
}
interface Project {
  name: string;
  root: string;
  url: string | null;
  manifest: Manifest;
}
interface Row {
  project: string;
  journey: string;
  item: string;
  ok: boolean;
  ms?: number;
  usd?: number;
  detail?: string;
  skipped?: string;
}

const projects = (): Project[] => JSON.parse(fs.readFileSync(path.join(WORK, 'projects.json'), 'utf8'));

async function api<T>(p: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${STUDIO}/api${p}`, body === undefined ? { method, headers } : { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
/** Today's spending on every app, in dollars. */
const spent = async () => (await api<{ today: { usd: number } }>('/ai/usage')).today.usd;

/** Every result, as each project finishes: a worker that restarts after a failure keeps adding to the same run. */
const RUN = process.env.EVAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
process.env.EVAL_RUN_ID = RUN;
const ROWS = path.join(OUT, `results-${RUN}.jsonl`);
const rows = (): Row[] => (fs.existsSync(ROWS) ? fs.readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function keep(row: Row): void {
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(ROWS, `${JSON.stringify(row)}\n`);
  console.log(`${row.skipped ? '–' : row.ok ? '✓' : '✗'} ${row.project} · ${row.journey} · ${row.item}${row.ms ? ` (${(row.ms / 1000).toFixed(1)} s)` : ''}${row.detail ? `: ${row.detail}` : ''}${row.skipped ? ` (skipped: ${row.skipped})` : ''}`);
}

test.afterAll(() => {
  const all = rows();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(ROWS.replace(/\.jsonl$/, '.md'), `${summary(all)}\n\n${all.map((r) => JSON.stringify(r)).join('\n')}\n`);
  console.log(`\n${summary(all)}\nResults: ${path.relative(ROOT, ROWS)}`);
});

const app = (page: Page): FrameLocator => page.frameLocator('iframe');
function find(page: Page, t: Target): Locator {
  const a = app(page);
  const l = 'testId' in t ? a.getByTestId(t.testId) : 'role' in t ? a.getByRole(t.role as Parameters<FrameLocator['getByRole']>[0], { name: t.name, exact: true }) : 'label' in t ? a.getByLabel(t.label, { exact: true }) : a.getByText(t.text, { exact: true });
  return t.nth === undefined ? l : l.nth(t.nth);
}
const describe = (t: Target) => ('testId' in t ? t.testId : 'role' in t ? `${t.role} “${t.name}”` : 'label' in t ? `“${t.label}”` : `“${t.text}”`) + (t.nth ? ` #${t.nth + 1}` : '');

/** The centre of an element of the app, on the page. */
async function centre(page: Page, t: Target): Promise<{ x: number; y: number }> {
  const l = find(page, t);
  await l.scrollIntoViewIfNeeded();
  const b = await l.boundingBox();
  if (!b) throw new Error(`${describe(t)} isn't on screen`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Open a page of the app, as its own address. */
async function goto(page: Page, p: string): Promise<void> {
  await app(page).locator('body').evaluate((_, to) => location.assign(new URL(to, location.href).href), p);
  await page.waitForTimeout(400);
  await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 30_000 }).toBe(true);
}

/** Do what a person does in the app. */
async function act(page: Page, flow: Step[]): Promise<void> {
  for (const s of flow) {
    if (s.do === 'goto') await goto(page, s.value ?? '/');
    else if (s.do === 'wait') await expect(find(page, s.target!)).toBeVisible({ timeout: 15_000 });
    else if (s.do === 'press') await (s.target ? find(page, s.target).press(s.value ?? 'Enter') : page.keyboard.press(s.value ?? 'Enter'));
    else {
      const el = find(page, s.target!);
      if (s.do === 'fill') await el.fill(s.value ?? '');
      else if (s.do === 'select') await el.selectOption(s.values ? s.values.map((label) => ({ label })) : { label: s.value ?? '' });
      else if (s.do === 'check') await el.check();
      else if (s.do === 'uncheck') await el.uncheck();
      else await el.click();
    }
    await page.waitForTimeout(250);
  }
}

const secretsOf = (flow: Step[], extra: Record<string, string> = {}) => [...flow.filter((s) => s.secret && s.value).map((s) => s.value!), ...Object.values(extra)];

/** Every file under `dir` that has any of `values` in it. */
function holding(dir: string, values: string[]): string[] {
  if (!values.length || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
      } else if (fs.statSync(p).size < 20_000_000) {
        const text = fs.readFileSync(p).toString('latin1');
        if (values.some((v) => text.includes(v))) out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

async function link(page: Page, p: Project): Promise<void> {
  const { probe } = await api<{ probe: unknown }>('/apps/probe', 'POST', { folder: p.root });
  await api('/apps', 'POST', { probe, url: p.url, start: null, name: p.manifest.name });
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
  await openStudio(page);
  await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 60_000 }).toBe(true);
}

/** Back to Edit mode on the app's first page, with nothing waiting. */
async function fresh(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  if ((await store<string>(page, 's.mode')) !== 'edit') await page.keyboard.press('e');
  await goto(page, '/');
}

// ───────────────────────────── journeys ─────────────────────────────

type Journey = (page: Page, p: Project, out: (r: Omit<Row, 'project' | 'journey'>) => void) => Promise<void>;

const point: Journey = async (page, p, out) => {
  for (const x of p.manifest.points ?? []) {
    if (x.path) await goto(page, x.path);
    const at = await centre(page, x.target);
    await page.mouse.move(at.x - 30, at.y - 30);
    const t0 = Date.now();
    await page.mouse.move(at.x, at.y);
    const src = await expect
      .poll(() => store<string | null>(page, 's.hover ? s.hover.src : null'), { timeout: 5000 })
      .toMatch(new RegExp(`^${x.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`))
      .then(
        () => null,
        async () => (await store<string | null>(page, 's.hover ? s.hover.src : null')) ?? 'nothing',
      );
    out({ item: describe(x.target), ok: src === null, ms: Date.now() - t0, detail: src === null ? undefined : `said ${src}, expected ${x.src}` });
    if (x.path) await goto(page, '/');
  }
};

const edit: Journey = async (page, p, out) => {
  for (const x of p.manifest.edits ?? []) {
    const file = path.join(p.root, x.file);
    const before = fs.readFileSync(file, 'utf8');
    const t0 = Date.now();
    let detail: string | undefined;
    try {
      if (x.path) await goto(page, x.path);
      const at = await centre(page, x.target);
      await page.mouse.click(at.x, at.y);
      await page.getByRole('textbox', { name: 'Describe a change' }).fill(x.say);
      await page.keyboard.press('Enter');
      const change = await expect
        .poll(async () => (await api<{ changes: { id: string; status: string }[] }>('/changes')).changes.find((c) => c.status === 'preview')?.id ?? null, { timeout: 15_000 })
        .not.toBeNull()
        .then(async () => (await api<{ changes: { id: string; status: string }[] }>('/changes')).changes.find((c) => c.status === 'preview')!.id);
      const after = fs.readFileSync(file, 'utf8');
      if (!after.includes(x.contains)) detail = `the file doesn't have “${x.contains}”`;
      await page.waitForTimeout(1200);
      if (await app(page).locator('vite-error-overlay').count()) detail = 'the app shows an error after the change';
      await api('/changes/undo', 'POST', { id: change, via: 'eval' });
      if (fs.readFileSync(file, 'utf8') !== before) detail = (detail ? `${detail}; ` : '') + 'undo left the file changed';
    } catch (err) {
      detail = (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '');
      if (fs.readFileSync(file, 'utf8') !== before) fs.writeFileSync(file, before);
    }
    out({ item: `${describe(x.target)}: “${x.say}”`, ok: !detail, ms: Date.now() - t0, detail });
    await fresh(page);
  }
};

const writeTest: Journey = async (page, p, out) => {
  for (const x of p.manifest.tests ?? []) {
    const t0 = Date.now();
    try {
      // A test of its own: what was recorded before isn't in it.
      await page.evaluate(() => (window as any).__saywright.newRecording());
      await goto(page, x.path ?? '/');
      await page.keyboard.press('r');
      await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
      await act(page, x.flow);
      const at = await centre(page, x.check.target);
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(800);
      await page.getByRole('textbox', { name: 'Describe a change' }).fill(`this should show ${x.check.expected}`);
      await page.keyboard.press('Enter');
      await expect.poll(() => store<number>(page, 's.recorder.expectations.length')).toBe(1);
      // The check is about the element pointed at.
      const t = x.check.target;
      const named = 'testId' in t ? t.testId : 'role' in t ? t.name : 'label' in t ? t.label : t.text;
      const locator = await store<string>(page, 's.recorder.expectations[0].locator');
      if (!locator.includes(named)) throw new Error(`the check went to ${locator}, not ${describe(t)}`);
      await page.evaluate(() => (window as any).__saywright.generateTest());
      await expect.poll(() => store<string | null>(page, 's.recorder.spec && s.recorder.spec.path'), { timeout: 30_000 }).toBeTruthy();
      const rel = await store<string>(page, 's.recorder.spec.path');
      const spec = fs.readFileSync(path.join(p.root, rel), 'utf8');
      for (const [name, value] of Object.entries(x.secrets ?? {})) await api('/tests/secrets', 'PUT', { name, value });
      const leaked = secretsOf(x.flow, x.secrets).filter((v) => spec.includes(v));
      const runs: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const r = await api<{ status: string; failedAt?: string; verified?: boolean; message?: string }>('/tests/run', 'POST', { path: rel });
        runs.push(r.status === 'failed' ? `failed at its ${r.failedAt ?? '?'}` : r.status === 'passed' ? (r.verified ? 'passed, verified' : 'passed, not verified') : `${r.status}: ${(r.message ?? '').split('\n')[0].slice(0, 120)}`);
      }
      const want = x.bug ? 'failed at its check' : 'passed, verified';
      const wrong = runs.filter((r) => r !== want);
      const detail = [leaked.length ? 'a secret is in the test' : '', wrong.length ? `${wrong.length} of ${RUNS} runs: ${[...new Set(wrong)].join('; ')} (expected: ${want})` : ''].filter(Boolean).join('; ');
      out({ item: x.name, ok: !detail, ms: Date.now() - t0, detail: detail || undefined });
    } catch (err) {
      out({ item: x.name, ok: false, ms: Date.now() - t0, detail: (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '') });
    }
    await page.evaluate(() => (window as any).__saywright.newRecording());
    await fresh(page);
  }
};

const session: Journey = async (page, p, out) => {
  for (const x of p.manifest.sessions ?? []) {
    const t0 = Date.now();
    try {
      await goto(page, x.path ?? '/');
      await page.getByRole('button', { name: 'Record session', exact: true }).click();
      await page.getByPlaceholder('What are you testing? (optional)').fill(x.name);
      await page.getByRole('button', { name: 'Start recording' }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled({ timeout: 20_000 });
      await act(page, x.flow);
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      const id = await expect
        .poll(async () => (await api<{ sessions: { id: string; name: string; status: string }[] }>('/sessions')).sessions.find((s) => s.name === x.name && (s.status === 'ready' || s.status === 'failed'))?.id ?? null, { timeout: 5 * 60_000, intervals: [1000] })
        .not.toBeNull()
        .then(async () => (await api<{ sessions: { id: string; name: string }[] }>('/sessions')).sessions.find((s) => s.name === x.name)!.id);
      const d = await api<{ meta: { status: string }; analysis: { steps: unknown[]; issues: { kind: string }[]; network: { failed: number } } | null }>(`/sessions/${id}`);
      const a = d.analysis;
      const problems: string[] = [];
      if (!a) problems.push(`no analysis (${d.meta.status})`);
      else {
        if (x.expect.steps !== undefined && a.steps.length < x.expect.steps) problems.push(`${a.steps.length} steps, expected ${x.expect.steps}`);
        const errors = a.issues.filter((i) => i.kind === 'error').length;
        if (x.expect.errors !== undefined && errors < x.expect.errors) problems.push(`${errors} errors, expected ${x.expect.errors}`);
        if (x.expect.failedRequests !== undefined && a.network.failed < x.expect.failedRequests) problems.push(`${a.network.failed} failed requests, expected ${x.expect.failedRequests}`);
      }
      const leaks = holding(path.join(p.root, '.saywright'), secretsOf(x.flow));
      if (leaks.length) problems.push(`a secret is in ${leaks.map((f) => path.relative(p.root, f)).join(', ')}`);
      out({ item: x.name, ok: !problems.length, ms: Date.now() - t0, detail: problems.join('; ') || undefined });
    } catch (err) {
      out({ item: x.name, ok: false, ms: Date.now() - t0, detail: (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '') });
    }
    await page.goto('/');
    await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 30_000 }).toBe(true);
  }
};

function patch(root: string, x: Patch, undo = false): void {
  const file = path.join(root, x.file);
  const [from, to] = undo ? [x.replace, x.find] : [x.find, x.replace];
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(from).length !== 2) throw new Error(`${x.file}: the patch doesn't apply`);
  fs.writeFileSync(file, text.replace(from, to));
}

const replay: Journey = async (page, p, out) => {
  for (const x of p.manifest.replays ?? []) {
    const t0 = Date.now();
    let item = `${x.name}: still happening before the fix`;
    try {
      if (x.break) patch(p.root, x.break);
      await page.waitForTimeout(1500);
      await goto(page, x.path ?? '/');
      await page.getByRole('button', { name: 'Record session', exact: true }).click();
      await page.getByPlaceholder('What are you testing? (optional)').fill(x.name);
      await page.getByRole('button', { name: 'Start recording' }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled({ timeout: 20_000 });
      await act(page, x.flow);
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      const id = await expect
        .poll(async () => (await api<{ sessions: { id: string; name: string; status: string }[] }>('/sessions')).sessions.find((s) => s.name === x.name && s.status === 'ready')?.id ?? null, { timeout: 5 * 60_000, intervals: [1000] })
        .not.toBeNull()
        .then(async () => (await api<{ sessions: { id: string; name: string }[] }>('/sessions')).sessions.find((s) => s.name === x.name)!.id);
      await page.goto(`/report/${id}`);
      const finding = page.locator('[data-findings] article', { hasText: x.finding }).first();
      await expect(finding).toBeVisible({ timeout: 30_000 });
      const verify = async (button: string) => {
        await page.locator(button).click();
        // Played on the stage: until it is over (the last replay's result is on the page meanwhile).
        await expect(page.locator('[data-island="replay"]')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('[data-island="replay"]')).toHaveCount(0, { timeout: 120_000 });
        await expect(page.locator('[data-verification="done"]')).toBeVisible({ timeout: 30_000 });
        return finding.getAttribute('data-verdict');
      };
      const before = await verify('[data-verify]');
      out({ item, ok: before === 'still', ms: Date.now() - t0, detail: before === 'still' ? undefined : `said ${before ?? 'nothing'}` });
      // The developer's fix.
      item = `${x.name}: fixed after the fix`;
      const t1 = Date.now();
      if (x.fix) patch(p.root, x.fix);
      else if (x.break) patch(p.root, x.break, true);
      await page.waitForTimeout(2000);
      const after = await verify('[data-verify-again]');
      out({ item, ok: after === 'fixed', ms: Date.now() - t1, detail: after === 'fixed' ? undefined : `said ${after ?? 'nothing'}` });
    } catch (err) {
      out({ item, ok: false, ms: Date.now() - t0, detail: (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '') });
    }
    // The project as it was.
    if (x.fix) {
      try {
        patch(p.root, x.fix, true);
      } catch {
        /* never applied */
      }
    } else if (x.break) {
      try {
        patch(p.root, x.break, true);
      } catch {
        /* already put back */
      }
    }
    await page.goto('/');
    await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 30_000 }).toBe(true);
  }
};

const experts: Journey = async (page, p, out) => {
  for (const x of p.manifest.experts ?? []) {
    const t0 = Date.now();
    try {
      await goto(page, x.path ?? '/');
      await page.locator('[role="tab"]', { hasText: 'Experts' }).click();
      await page.locator('[data-review-page]').click();
      await expect(page.locator('[data-review-page]')).toHaveText(/Review again/, { timeout: 60_000 });
      const rules = await page.locator('[data-finding]').evaluateAll((els) => els.map((e) => e.getAttribute('data-finding')));
      const missing = x.expect.filter((r) => !rules.includes(r));
      out({ item: x.path ?? '/', ok: !missing.length, ms: Date.now() - t0, detail: missing.length ? `missing ${missing.join(', ')} (found ${rules.length}: ${rules.slice(0, 12).join(', ')})` : undefined });
    } catch (err) {
      out({ item: x.path ?? '/', ok: false, ms: Date.now() - t0, detail: (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '') });
    }
    await fresh(page);
  }
};

const mcp: Journey = async (page, p, out) => {
  const x = p.manifest.mcp;
  if (!x) return;
  const { mcp: m } = await api<{ mcp: { url: string; token: string } }>('/ai');
  let id = 0;
  const call = async (method: string, params: unknown, token = m.token) => {
    const res = await fetch(m.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const text = await res.text();
    const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
    return { status: res.status, json } as { status: number; json: { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { message: string } } };
  };
  const text = (r: Awaited<ReturnType<typeof call>>) => r.json.result?.content?.map((c) => c.text).join('\n') ?? r.json.error?.message ?? '';
  const step = async (item: string, run: () => Promise<string | undefined>) => {
    const t0 = Date.now();
    const detail = await run().catch((err) => (err instanceof Error ? err.message.split('\n')[0] : String(err)));
    out({ item, ok: !detail, ms: Date.now() - t0, detail });
  };
  await step('a wrong token is refused', async () => ((await call('tools/list', {}, 'not-the-token')).status === 401 ? undefined : 'it was accepted'));
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'usage-eval', version: '1' } });
  await step('tools', async () => {
    const names = (await call('tools/list', {})).json.result?.tools?.map((t) => t.name) ?? [];
    const missing = ['get_context', 'read_file', 'search_code', 'propose_change'].filter((n) => !names.includes(n));
    return missing.length ? `missing ${missing.join(', ')}` : undefined;
  });
  await step('get_context after selecting', async () => {
    const first = p.manifest.points?.[0];
    if (!first) return 'the manifest has no point to select';
    const at = await centre(page, first.target);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(600);
    const t = text(await call('tools/call', { name: 'get_context', arguments: {} }));
    return t.includes(first.src.split(':')[0]) ? undefined : `no ${first.src} in: ${t.slice(0, 160)}`;
  });
  await page.keyboard.press('Escape');
  await step('read_file', async () => {
    const t = text(await call('tools/call', { name: 'read_file', arguments: { path: x.read } }));
    return t.split('\n').length > 3 ? undefined : `got: ${t.slice(0, 160)}`;
  });
  await step('read_file outside the project is refused', async () => {
    const r = await call('tools/call', { name: 'read_file', arguments: { path: '../../../../../package.json' } });
    return r.json.result?.isError || r.json.error ? undefined : `it answered: ${text(r).slice(0, 120)}`;
  });
  await step('search_code', async () => {
    const t = text(await call('tools/call', { name: 'search_code', arguments: { query: x.search } }));
    return t.includes(x.read) ? undefined : `no ${x.read} in: ${t.slice(0, 160)}`;
  });
  await step('propose_change, then undo', async () => {
    const file = path.join(p.root, x.read);
    const before = fs.readFileSync(file, 'utf8');
    const first = before.split('\n')[0];
    const r = await call('tools/call', { name: 'propose_change', arguments: { title: 'A comment', summary: 'Adds a comment line', edits: [{ path: x.read, old_string: first, new_string: `// usage-eval\n${first}` }] } });
    if (r.json.result?.isError || r.json.error) return text(r).slice(0, 160);
    if (!fs.readFileSync(file, 'utf8').startsWith('// usage-eval')) return 'the file didn’t change';
    const shown = await expect.poll(async () => (await api<{ changes: { id: string; status: string }[] }>('/changes')).changes.find((c) => c.status === 'preview')?.id ?? null).not.toBeNull().then(
      () => true,
      () => false,
    );
    const pending = (await api<{ changes: { id: string; status: string }[] }>('/changes')).changes.find((c) => c.status === 'preview');
    if (pending) await api('/changes/undo', 'POST', { id: pending.id, via: 'eval' });
    if (fs.readFileSync(file, 'utf8') !== before) return 'undo left the file changed';
    return shown ? undefined : 'the studio didn’t show it';
  });
};

const aiChange: Journey = async (page, p, out) => {
  for (const x of p.manifest.ai ?? []) {
    if (!AI) {
      out({ item: x.name, ok: false, skipped: 'EVAL_AI is not real' });
      continue;
    }
    if ((await spent()) >= BUDGET) {
      out({ item: x.name, ok: false, skipped: 'budget' });
      continue;
    }
    const usd0 = await spent();
    const t0 = Date.now();
    let detail: string | undefined;
    try {
      if (x.path) await goto(page, x.path);
      const at = await centre(page, x.target);
      await page.mouse.click(at.x, at.y);
      await page.getByRole('textbox', { name: 'Describe a change' }).fill(x.say);
      await page.keyboard.press('Enter');
      await expect.poll(() => store<boolean>(page, '!!s.request'), { timeout: 10_000 }).toBe(true).catch(() => undefined);
      await expect.poll(() => store<boolean>(page, '!!s.request'), { timeout: 5 * 60_000, intervals: [1000] }).toBe(false);
      const change = (await api<{ changes: { id: string; status: string }[] }>('/changes')).changes.find((c) => c.status === 'preview');
      if (!change) detail = 'no change came';
      else {
        await page.waitForTimeout(2000);
        if (await app(page).locator('vite-error-overlay').count()) detail = 'the app shows an error after the change';
        else await act(page, x.then).catch((err) => (detail = `after it: ${(err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '')}`));
        await api('/changes/undo', 'POST', { id: change.id, via: 'eval' });
      }
    } catch (err) {
      detail = (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '');
    }
    out({ item: x.name, ok: !detail, ms: Date.now() - t0, usd: +((await spent()) - usd0).toFixed(4), detail });
    await fresh(page);
  }
};

const JOURNEYS: [string, Journey][] = [
  ['point', point],
  ['edit', edit],
  ['test', writeTest],
  ['session', session],
  ['replay', replay],
  ['experts', experts],
  ['mcp', mcp],
  ['ai', aiChange],
];

for (const p of fs.existsSync(path.join(WORK, 'projects.json')) ? projects() : []) {
  test(`${p.manifest.name} (${p.manifest.stack})`, async ({ page }) => {
    await link(page, p);
    for (const [journey, run] of JOURNEYS) {
      try {
        await run(page, p, (r) => keep({ project: p.manifest.name, journey, ...r }));
      } catch (err) {
        // One journey's trouble is a result like any other; the next journey starts afresh.
        keep({ project: p.manifest.name, journey, item: '(the journey)', ok: false, detail: (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '') });
        await page.goto('/').catch(() => undefined);
        await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 30_000 }).toBe(true).catch(() => undefined);
      }
    }
    await api('/apps/close', 'POST', {}).catch(() => undefined);
  });
}

function summary(all: Row[]): string {
  const ran = all.filter((r) => !r.skipped);
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : '—');
  const by = (key: (r: Row) => string) => {
    const m = new Map<string, Row[]>();
    for (const r of ran) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m.entries()];
  };
  const usd = all.reduce((n, r) => n + (r.usd ?? 0), 0);
  return [
    'Saywright usage benchmark',
    `  All journeys: ${pct(ran.filter((r) => r.ok).length, ran.length)} passed${all.length > ran.length ? `, ${all.length - ran.length} skipped` : ''}${usd ? `, $${usd.toFixed(3)} of AI` : ''}`,
    ...by((r) => r.journey).map(([j, rs]) => `  ${j.padEnd(8)} ${pct(rs.filter((r) => r.ok).length, rs.length)}`),
    ...by((r) => r.project).map(([pr, rs]) => `  ${pr}: ${pct(rs.filter((r) => r.ok).length, rs.length)}`),
    ...ran.filter((r) => !r.ok).map((r) => `  ✗ ${r.project} · ${r.journey} · ${r.item}: ${r.detail ?? ''}`),
  ].join('\n');
}
