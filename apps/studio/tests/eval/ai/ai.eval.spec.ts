/**
 * The real-model benchmark: Saywright's whole loop (observe → reproduce → fix → verify) on small apps the AI has
 * never seen, each with a seeded bug and a bug-free twin, with your AI. Opt-in and paid: `npm run eval:ai`.
 *
 * For each app and twin:
 *   observe    a session of someone using it (no narration) and its AI report: is the bug found (a bug finding at
 *              its file, or in its words)? On the twin, every bug finding is a false positive.
 *   reproduce  Write test from the same use and the value the app should show, run EVAL_RUNS times: it must fail at
 *              its check on the app with the bug (reproduced), and pass, verified, on the twin (else a false positive).
 *   fix        on the app with the bug: “Fix with …”, the same test run again. A fix succeeds only when the test passes
 *              verified, the test file is untouched, and the app shows the other values it should (an oracle the AI
 *              never saw).
 * Each AI step's time and cost (from the studio's own usage tracker) is kept. EVAL_BUDGET (dollars, default 3) stops
 * the AI steps once spent. Results: printed, and in .saywright/ai-eval/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { appPoint, openStudio, store } from '../../e2e/helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../../..');
const WORK = path.resolve(here, '../../.eval-work');
const STUDIO = `http://localhost:${process.env.EVAL_STUDIO_PORT || 5373}`;
const RUNS = Number(process.env.EVAL_RUNS || 2);
const BUDGET = Number(process.env.EVAL_BUDGET || 3);
const OUT = path.join(ROOT, '.saywright', 'ai-eval');
// oxlint-disable-next-line no-control-regex -- the escape character starts the terminal's colour codes
const ANSI = /\x1b\[[0-9;]*m/g;

interface Step {
  do: 'fill' | 'select' | 'check' | 'click';
  label: string;
  value?: string;
  secret?: boolean;
}
interface Bench {
  name: string;
  about: string;
  start: string;
  flow: Step[];
  check: { testId: string; expected: string };
  secrets?: Record<string, string>;
  bug: { file: string; words: string[] };
  oracle: { testId: string; expected: string }[];
}
interface App {
  name: string;
  variant: 'bug' | 'twin';
  root: string;
  url: string;
  bench: Bench;
}

const apps = (): App[] => JSON.parse(fs.readFileSync(path.join(WORK, 'apps.json'), 'utf8'));

async function api<T>(p: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${STUDIO}/api${p}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** What the studio's usage tracker says was spent today, in dollars. */
const spent = async () => (await api<{ ai: { usage: { usd: number } } }>('/status')).ai.usage.usd;

interface Row {
  app: string;
  variant: string;
  model?: string;
  observe?: { found: boolean | null; bugFindings: number; falsePositives: number; seconds: number; usd: number; titles: string[] } | { skipped: string };
  reproduce?: { runs: { status: string; failedAt?: string; verified?: boolean }[]; reproduced: number; falsePositive: boolean };
  fix?: { verified: boolean; testUntouched: boolean; oracle: boolean; files: string[]; seconds: number; usd: number; outcome: string } | { skipped: string };
  error?: string;
}
/** Every result, as each app finishes: a worker that restarts after a failure keeps adding to the same run. */
const RUN = process.env.EVAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
process.env.EVAL_RUN_ID = RUN;
const ROWS = path.join(OUT, `results-${RUN}.jsonl`);
const rows = (): Row[] => (fs.existsSync(ROWS) ? fs.readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test.beforeAll(async () => {
  const status = await api<{ ai: { ready: boolean; who: { label: string; model: string } | null } }>('/status');
  test.skip(!status.ai.ready, 'No AI is connected: set ANTHROPIC_API_KEY (or another provider) to run the benchmark.');
  console.log(`AI: ${status.ai.who?.label} · ${status.ai.who?.model}. Budget: $${BUDGET}.`);
});

test.afterAll(() => {
  const all = rows();
  const file = ROWS.replace(/\.jsonl$/, '.md');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, `${summary(all)}\n\n${all.map((r) => JSON.stringify(r)).join('\n')}\n`);
  console.log(`\n${summary(all)}\nResults: ${path.relative(ROOT, ROWS)}`);
});

/** Do what someone using the app does (in the studio's frame). */
async function use(page: Page, flow: Step[]): Promise<void> {
  const app = page.frameLocator('iframe');
  for (const s of flow) {
    const el = s.do === 'click' ? app.getByRole('button', { name: s.label, exact: true }) : app.getByLabel(s.label, { exact: true });
    if (s.do === 'fill') await el.fill(s.value ?? '');
    else if (s.do === 'select') await el.selectOption({ label: s.value ?? '' });
    else if (s.do === 'check') await el.check();
    else await el.click();
    await page.waitForTimeout(250);
  }
}

async function link(page: Page, a: App): Promise<void> {
  const { probe } = await api<{ probe: unknown }>('/apps/probe', 'POST', { folder: a.root });
  await api('/apps', 'POST', { probe, url: a.url, start: null, name: `${a.bench.name} (${a.variant})` });
  // A session with no countdown and no narration (the microphone plays silence).
  await page.addInitScript(() => localStorage.setItem('saywright.session.prefs', JSON.stringify({ lang: 'en', mic: false, screen: false, video: false, countdown: 0 })));
  await openStudio(page);
  await expect.poll(() => store<string>(page, 's.app.url'), { timeout: 30_000 }).toContain(new URL(a.url).host);
}

for (const a of fs.existsSync(path.join(WORK, 'apps.json')) ? apps() : []) {
  test(`${a.bench.name}, ${a.variant === 'bug' ? 'with its bug' : 'its bug-free twin'}`, async ({ page }) => {
    const row: Row = { app: a.name, variant: a.variant };
    try {
      await link(page, a);
      row.model = (await api<{ ai: { who: { model: string } | null } }>('/status')).ai.who?.model;

      // ---- observe: a session of the same use, and its AI report ----
      if ((await spent()) >= BUDGET) row.observe = { skipped: 'budget' };
      else {
        const usd0 = await spent();
        await page.getByRole('button', { name: 'Record session', exact: true }).click();
        await page.getByRole('button', { name: 'Start recording' }).click();
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
        await use(page, a.bench.flow);
        await page.waitForTimeout(2000);
        const t0 = Date.now();
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await page.getByRole('button', { name: 'Report ready' }).click({ timeout: 5 * 60_000 });
        const seconds = (Date.now() - t0) / 1000;
        const id = new URL(page.url()).pathname.split('/').pop()!;
        const d = await api<{ report: { findings: { category: string; severity: string; title: string; what: string; location?: string; shown?: string; fix?: string }[] } | null }>(`/sessions/${id}`);
        const findings = d.report?.findings ?? [];
        const bugs = findings.filter((f) => f.category === 'bug' && (f.severity === 'high' || f.severity === 'medium' || f.severity === 'critical'));
        const words = a.bench.bug.words.map((w) => w.toLowerCase());
        const about = (f: (typeof findings)[number]) => `${f.location ?? ''} ${f.shown ?? ''}`.includes(path.basename(a.bench.bug.file)) || words.some((w) => `${f.title} ${f.what} ${f.fix ?? ''}`.toLowerCase().includes(w));
        row.observe = {
          found: a.variant === 'bug' ? bugs.some(about) : null,
          bugFindings: bugs.length,
          falsePositives: a.variant === 'twin' ? bugs.length : 0,
          seconds,
          usd: +((await spent()) - usd0).toFixed(4),
          titles: findings.map((f) => `${f.severity} ${f.category}: ${f.title}`),
        };
        await page.goto('/');
        await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 30_000 }).toBe(true);
      }

      // ---- reproduce: Write test from the same use, and what it should show ----
      await page.frameLocator('iframe').locator('body').evaluate(() => location.reload());
      await expect.poll(() => store<boolean>(page, 's.app.connected'), { timeout: 30_000 }).toBe(true);
      await page.keyboard.press('r');
      await expect.poll(() => store<string>(page, 's.mode')).toBe('record');
      await use(page, a.bench.flow);
      const at = await appPoint(page, a.bench.check.testId, 0.5);
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(800);
      await page.getByRole('textbox', { name: 'Describe a change' }).fill(`this should show ${a.bench.check.expected}`);
      await page.keyboard.press('Enter');
      await expect.poll(() => store<number>(page, 's.recorder.expectations.length')).toBe(1);
      await page.evaluate(() => (window as any).__saywright.generateTest());
      await expect.poll(() => store<string | null>(page, 's.recorder.spec && s.recorder.spec.path'), { timeout: 30_000 }).toBeTruthy();
      for (const [name, value] of Object.entries(a.bench.secrets ?? {})) await api('/tests/secrets', 'PUT', { name, value });
      const specPath = path.join(a.root, await store<string>(page, 's.recorder.spec.path'));
      const spec = fs.readFileSync(specPath, 'utf8');
      // A secret typed while writing the test is never in it.
      for (const value of Object.values(a.bench.secrets ?? {})) expect(spec).not.toContain(value);
      const runs: { status: string; failedAt?: string; verified?: boolean; hash?: string }[] = [];
      for (let i = 0; i < RUNS; i++) {
        const r = await api<{ status: string; failedAt?: string; verified?: boolean; hash?: string }>('/tests/run', 'POST', { path: path.relative(a.root, specPath).split(path.sep).join('/') });
        runs.push({ status: r.status, failedAt: r.failedAt, verified: r.verified, hash: r.hash });
      }
      const reproduced = runs.filter((r) => r.status === 'failed' && r.failedAt === 'check').length;
      row.reproduce = { runs: runs.map(({ hash: _h, ...r }) => r), reproduced, falsePositive: a.variant === 'twin' && runs.some((r) => !(r.status === 'passed' && r.verified)) };

      // ---- fix: the AI, checked by the same test, untouched, and by what it never saw ----
      if (a.variant === 'twin') return;
      if (!reproduced) row.fix = { skipped: 'not reproduced' };
      else if ((await spent()) >= BUDGET) row.fix = { skipped: 'budget' };
      else {
        // The run the fix is checked against: the studio's own last one, in its state.
        await page.evaluate(() => (window as any).__saywright.runTest());
        await expect.poll(() => store<string | undefined>(page, 's.recorder.run && s.recorder.run.status'), { timeout: 120_000 }).toBe('failed');
        const usd0 = await spent();
        const t0 = Date.now();
        const failedAt = await store<number>(page, 's.recorder.run.at');
        await page.evaluate(() => (window as any).__saywright.fix());
        // The fix request, until it is over (it starts at once, and can take minutes).
        await expect.poll(() => store<boolean>(page, '!!s.request || s.recorder.verifying'), { timeout: 10_000 }).toBe(true).catch(() => undefined);
        await expect.poll(() => store<boolean>(page, '!!s.request && s.request.kind === "fix"'), { timeout: 8 * 60_000, intervals: [1000] }).toBe(false);
        const seconds = (Date.now() - t0) / 1000;
        // A change came: the studio runs the test again with it; that run, until it is back.
        if (await store<boolean>(page, 's.recorder.verifying')) {
          await expect
            .poll(() => store<boolean>(page, `!s.recorder.verifying && !s.recorder.running && !!s.recorder.run && s.recorder.run.at > ${failedAt}`), { timeout: 4 * 60_000, intervals: [1000] })
            .toBe(true)
            .catch(() => undefined);
        }
        const run = await store<{ status: string; verified?: boolean; unverified?: string } | null>(page, 's.recorder.run');
        const changes = await store<{ id: string; status: string; files: { path: string }[] }[]>(page, 's.changes.map((c) => ({ id: c.id, status: c.status, files: (c.files ?? []).map((f) => ({ path: f.path })) }))');
        const preview = changes.find((c) => c.status === 'preview');
        const testUntouched = fs.readFileSync(specPath, 'utf8') === spec;
        let oracle = false;
        if (run?.status === 'passed' && run.verified) {
          // What the app shows besides the check: the AI never saw these.
          const app = page.frameLocator('iframe');
          await page.waitForTimeout(1500);
          oracle = true;
          for (const o of a.bench.oracle) {
            const text = (await app.getByTestId(o.testId).innerText().catch(() => '')).trim();
            if (!text.includes(o.expected)) oracle = false;
          }
        }
        row.fix = {
          verified: run?.status === 'passed' && !!run.verified,
          testUntouched,
          oracle,
          files: preview?.files.map((f) => f.path) ?? [],
          seconds,
          usd: +((await spent()) - usd0).toFixed(4),
          outcome: run ? `${run.status}${run.verified ? ', verified' : run.unverified ? `, not verified: ${run.unverified}` : ''}` : 'no run',
        };
        // The copy goes back as it was: the next run starts from the bug again.
        if (preview) await api('/changes/undo', 'POST', { id: preview.id, via: 'eval' }).catch(() => undefined);
      }
    } catch (err) {
      // A result like any other: kept and counted, so one app's trouble doesn't stop the others.
      row.error = (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(ANSI, '');
      test.info().annotations.push({ type: 'error', description: row.error });
    } finally {
      fs.mkdirSync(OUT, { recursive: true });
      fs.appendFileSync(ROWS, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
      await api('/apps/close', 'POST', {}).catch(() => undefined);
    }
  });
}

function summary(all: Row[]): string {
  const bug = all.filter((r) => r.variant === 'bug');
  const twin = all.filter((r) => r.variant === 'twin');
  const obs = (r: Row) => (r.observe && 'found' in r.observe ? r.observe : null);
  const fix = (r: Row) => (r.fix && 'verified' in r.fix ? r.fix : null);
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : '—');
  const found = bug.filter((r) => obs(r)?.found).length;
  const observed = bug.filter((r) => obs(r)).length;
  const runs = bug.reduce((n, r) => n + (r.reproduce?.runs.length ?? 0), 0);
  const repro = bug.reduce((n, r) => n + (r.reproduce?.reproduced ?? 0), 0);
  const twinRuns = twin.reduce((n, r) => n + (r.reproduce?.runs.length ?? 0), 0);
  const twinFalse = twin.reduce((n, r) => n + (r.reproduce?.runs.filter((x) => !(x.status === 'passed' && x.verified)).length ?? 0), 0);
  const reportFalse = twin.reduce((n, r) => n + (obs(r)?.falsePositives ?? 0), 0);
  const fixes = bug.filter((r) => fix(r));
  const fixed = fixes.filter((r) => fix(r)!.verified && fix(r)!.testUntouched && fix(r)!.oracle).length;
  const usd = all.reduce((n, r) => n + (obs(r)?.usd ?? 0) + (fix(r)?.usd ?? 0), 0);
  const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '—');
  return [
    'Saywright AI benchmark',
    `  Bug found by the session report:       ${pct(found, observed)}`,
    `  Report bug findings on bug-free twins: ${reportFalse} (false positives)`,
    `  Bug reproduced by the generated test:  ${pct(repro, runs)} of runs`,
    `  Test failing on bug-free twins:        ${pct(twinFalse, twinRuns)} of runs (false positives)`,
    `  Fixed (verified, test untouched, oracle right): ${pct(fixed, fixes.length)}`,
    `  Report time: ${mean(all.flatMap((r) => (obs(r) ? [obs(r)!.seconds] : [])))} s on average · fix time: ${mean(fixes.map((r) => fix(r)!.seconds))} s on average`,
    `  Cost: $${usd.toFixed(3)} in all`,
    ...all.filter((r) => r.error).map((r) => `  Could not finish ${r.app} (${r.variant}): ${r.error}`),
  ].join('\n');
}
