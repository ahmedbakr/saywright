/**
 * Runs a generated test with Playwright, and says what the run proves. The test runs with a configuration of the
 * studio's own (kept with the studio's data, never in the app's code): Chromium, no retries, no web server of its
 * own (the app the studio has open is the one tested), a fresh browser, and a JSON report. The app's own Playwright
 * configuration can't change the verdict (its retries, its browsers, its other tests), but its setup can come along:
 * a `tests/saywright/setup.ts` runs first, to put the data the test needs in place.
 *
 * A pass is believed only when every step and check of the test reported that it ran and passed, on the first try,
 * and the test is the one it is compared with. A failure says where: at a check (the bug shows) or at an earlier
 * step (the test didn't get that far: it doesn't show the bug yet).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MASK, maskSecrets, secretEnvName } from '@saywright/vite/protocol';
import type { RunStep, TestRunResult } from '../../shared/api.ts';
import { focusOn } from '../../shared/text.ts';
import { spawnProgram } from '../program.ts';
import type { Project } from '../project.ts';
import { secretsOf } from './generate.ts';

export { focusOn };

// oxlint-disable-next-line no-control-regex -- the escape character starts the terminal's colour codes
const ANSI = /\x1b\[[0-9;]*m/g;

function playwrightCli(project: Project): string[] {
  try {
    const req = createRequire(path.join(project.root, 'package.json'));
    return [process.execPath, req.resolve('@playwright/test/cli')];
  } catch {
    return ['npx', 'playwright'];
  }
}

function run(cmd: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, onLine?: (line: string) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnProgram(cmd[0], cmd.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout!.on('data', (d) => (stdout += d));
    child.stderr!.on('data', (d) => {
      stderr += d;
      if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.replace(ANSI, '').trim());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface PwStep {
  title: string;
  error?: { message?: string };
}
interface PwResult {
  status: string;
  retry?: number;
  duration: number;
  error?: { message?: string };
  errors?: { message?: string }[];
  steps?: PwStep[];
}
interface PwSpec {
  tests: { results: PwResult[] }[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  errors?: { message?: string }[];
}

/** Every test's runs (retries included), in the order the report lists them. */
function collect(suite: PwSuite, out: PwResult[][]): void {
  for (const spec of suite.specs ?? []) for (const t of spec.tests) out.push(t.results);
  for (const s of suite.suites ?? []) collect(s, out);
}

export function parseFailure(message: string): { expected?: string; received?: string } {
  const clean = message.replace(ANSI, '');
  const expected = /Expected (?:substring|string|pattern|value)?:?\s*"?(.*?)"?\s*$/m.exec(clean)?.[1];
  const received = /Received (?:string|value)?:?\s*"?(.*?)"?\s*$/m.exec(clean)?.[1];
  return { expected, received: focusOn(received, expected) };
}

const NEEDS_BROWSER = /Executable doesn't exist|download new browsers|npx playwright install/i;
/** A step or check of a generated test, by the mark its title starts with. */
const MARK = /^\[(\d+|check \d+)\] /;

/** The steps and checks a test has, as its code names them (in order). */
export function marksOf(code: string): string[] {
  return Array.from(code.matchAll(/\btest\.step\('\[(\d+|check \d+)\] /g), (m) => m[1]);
}

/** A short fingerprint of a test's code: a later run compares it, to know the test is the same one. */
export const hashOf = (code: string): string => createHash('sha256').update(code).digest('hex').slice(0, 16);

/** The values of secrets, masked out of what a run says (its errors and output). */
/** What a run says, without the saved secrets' values, and without any key or card number the page showed (it goes to the AI with Fix with …). */
function masker(values: string[]): (text: string | undefined) => string | undefined {
  const all = values.filter((v) => v.length >= 3).sort((a, b) => b.length - a.length);
  return (text) => (text === undefined ? text : maskSecrets(all.reduce((t, v) => t.split(v).join(MASK), text)));
}

/**
 * What a run proves, from every test the file has (`results`: each one's last try). `marks`: the steps and checks
 * the test has. `ended`: how Playwright itself ended. A pass is believed only when every test passed on its first
 * try, every step and check reported running and none of them failed (even where the test caught the error and went
 * on), and Playwright ended cleanly.
 */
export function judge(
  results: PwResult | PwResult[],
  marks: string[],
  mask: (t: string | undefined) => string | undefined,
  ended: { exit?: number | null; errors?: string[] } = {},
): Pick<TestRunResult, 'status' | 'verified' | 'unverified' | 'failedAt' | 'steps' | 'counts' | 'message'> {
  const all = Array.isArray(results) ? results : [results];
  const steps: RunStep[] = all.flatMap((r) =>
    (r.steps ?? [])
      .filter((s) => MARK.test(s.title))
      .map((s) => ({ title: mask(s.title)!, check: /^\[check /.test(s.title), ok: !s.error, error: s.error?.message ? mask(s.error.message.replace(ANSI, '').slice(0, 1200)) : undefined })),
  );
  const seen = new Set(steps.map((s) => MARK.exec(s.title)![1]));
  const isCheck = (m: string) => m.startsWith('check ');
  const counts = {
    steps: marks.filter((m) => !isCheck(m)).length,
    checks: marks.filter(isCheck).length,
    stepsPassed: steps.filter((s) => !s.check && s.ok).length,
    checksPassed: steps.filter((s) => s.check && s.ok).length,
  };
  const bad = all.find((r) => r.status !== 'passed' && r.status !== 'skipped');
  const failing = steps.find((s) => !s.ok);
  if (!bad) {
    // A check (or step) that failed, though its test caught the error and went on: it failed all the same.
    if (failing) {
      const why = `${failing.title} failed, though the test caught the error and went on: ${failing.error ?? 'no message'}`;
      return { status: 'failed', failedAt: failing.check ? 'check' : 'step', message: why.slice(0, 1200), steps, counts };
    }
    if (all.every((r) => r.status === 'skipped')) return { status: 'error', message: 'The test was skipped, so it shows nothing.', steps, counts };
    const missing = marks.filter((m) => !seen.has(m));
    if (!marks.length) return { status: 'passed', verified: false, unverified: 'This test has no numbered steps (an older version of Saywright wrote it, or it was written by hand), so a pass can’t show that each step and check ran. Generate it again.', steps, counts };
    if (!counts.checks) return { status: 'passed', verified: false, unverified: 'This test has no check, so a pass only shows its steps ran.', steps, counts };
    if (missing.length) return { status: 'passed', verified: false, unverified: `The test passed, but ${missing.length === 1 ? 'a step' : `${missing.length} steps`} of it didn’t report running (${missing.map((m) => `[${m}]`).join(', ')}).`, steps, counts };
    if (all.some((r) => r.status === 'skipped')) return { status: 'passed', verified: false, unverified: `${all.filter((r) => r.status === 'skipped').length === 1 ? 'A test' : 'Some tests'} in this file were skipped, so the file wasn’t run whole.`, steps, counts };
    if (all.some((r) => (r.retry ?? 0) > 0)) return { status: 'passed', verified: false, unverified: 'The test passed only when tried again.', steps, counts };
    // Every test passed, and Playwright still ended with an error (in its setup, or outside the tests): not clean.
    if ((ended.exit ?? 0) !== 0 || ended.errors?.length) {
      const said = ended.errors?.[0] ? mask(ended.errors[0].replace(ANSI, ''))!.split('\n')[0].slice(0, 300) : `it exited with code ${ended.exit}`;
      return { status: 'passed', verified: false, unverified: `The test passed, but Playwright didn’t end cleanly: ${said}.`, steps, counts };
    }
    return { status: 'passed', verified: true, steps, counts };
  }
  const message = mask((failing?.error ?? bad.error?.message ?? bad.errors?.[0]?.message ?? bad.status).replace(ANSI, ''))!;
  return { status: 'failed', failedAt: failing?.check ? 'check' : 'step', message: message.slice(0, 1200), steps, counts };
}

export interface RunOptions {
  /** The address of the app the studio has open: the test's baseURL. */
  baseUrl: string;
  /** Where the run's configuration and report are written (the studio's data, never the app's code). */
  workDir: string;
  /** The values of secrets the studio keeps for this app, by name (PASSWORD). The environment's are used too. */
  secrets?: Record<string, string>;
  /** The test's fingerprint when it last failed: a pass of a test changed since then doesn't prove a fix. */
  baseline?: string;
}

/** A value as JavaScript source: the studio's configuration is written as a module with no imports. */
const js = (v: unknown) => JSON.stringify(v);

export async function runSpec(project: Project, rel: string, opts: RunOptions): Promise<TestRunResult> {
  const file = project.resolve(rel); // refuses anything outside the project
  const started = Date.now();
  let code: string;
  try {
    code = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'error', durationMs: 0, message: `${rel} isn’t there any more.` };
  }
  const hash = hashOf(code);
  // Every secret it types must have a value: a test that types an empty password fails for the wrong reason.
  const env: NodeJS.ProcessEnv = { ...process.env, SAYWRIGHT_TARGET_URL: opts.baseUrl, FORCE_COLOR: '0' };
  delete env.CI;
  const values: string[] = [];
  const missingSecrets: string[] = [];
  for (const name of secretsOf(code)) {
    const v = opts.secrets?.[name] || process.env[secretEnvName(name)];
    if (v) {
      env[secretEnvName(name)] = v;
      values.push(v);
    } else missingSecrets.push(name);
  }
  if (missingSecrets.length) {
    return { status: 'setup-needed', durationMs: 0, hash, missingSecrets, message: `This test types ${missingSecrets.join(', ')}. Save ${missingSecrets.length > 1 ? 'them' : 'it'} in the Test tab (kept on this computer only, never in the test), or set ${missingSecrets.map((n) => secretEnvName(n)).join(', ')}.` };
  }
  const mask = masker(values);

  fs.mkdirSync(opts.workDir, { recursive: true, mode: 0o700 });
  sweepRuns(opts.workDir);
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const configFile = path.join(opts.workDir, `run-${id}.config.mjs`);
  const reportFile = path.join(opts.workDir, `run-${id}.json`);
  const outputDir = path.join(opts.workDir, `run-${id}`);
  const setup = ['setup.ts', 'setup.mjs', 'setup.js'].map((f) => path.join(path.dirname(file), f)).find((f) => fs.existsSync(f));
  const chromium = process.env.PW_CHROMIUM_PATH;
  fs.writeFileSync(
    configFile,
    `// Written by Saywright for one run of ${js(rel)}; removed after it.
export default {
  testDir: ${js(path.dirname(file))},
  testMatch: ${js(path.basename(file))},
  outputDir: ${js(outputDir)},
  retries: 0,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['json', { outputFile: ${js(reportFile)} }]],
${setup ? `  globalSetup: ${js(setup)},\n` : ''}  use: {
    baseURL: ${js(opts.baseUrl)},
    browserName: 'chromium',
    actionTimeout: 15000,
    navigationTimeout: 30000,
${chromium ? `    launchOptions: { executablePath: ${js(chromium)} },\n` : ''}  },
};
`,
  );
  try {
    const { code: exit, stdout, stderr } = await run([...playwrightCli(project), 'test', '--config', configFile], project.root, env, 180_000);
    const durationMs = Date.now() - started;
    const all = mask(`${stdout}\n${stderr}`)!.replace(ANSI, '');
    if (NEEDS_BROWSER.test(all)) return { status: 'setup-needed', durationMs, hash, message: 'Playwright needs its Chromium browser (one-time, about 150 MB).' };
    if (/Cannot find module '@playwright\/test'|Cannot find package '@playwright\/test'/.test(all)) {
      const pm = fs.existsSync(path.join(project.root, 'pnpm-lock.yaml')) ? 'pnpm add -D' : fs.existsSync(path.join(project.root, 'yarn.lock')) ? 'yarn add -D' : fs.existsSync(path.join(project.root, 'bun.lockb')) || fs.existsSync(path.join(project.root, 'bun.lock')) ? 'bun add -d' : 'npm i -D';
      return { status: 'setup-needed', durationMs, hash, message: `This project needs @playwright/test. Run: ${pm} @playwright/test` };
    }
    let report: PwReport;
    try {
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch {
      return { status: 'error', durationMs, hash, message: 'Couldn’t read the test results.', output: all.slice(-2000) };
    }
    const runs: PwResult[][] = [];
    for (const s of report.suites ?? []) collect(s, runs);
    // Every test in the file, each by its last try: a file with a second test that fails doesn't pass.
    const finals = runs.filter((r) => r.length).map((r) => r[r.length - 1]);
    if (!finals.length) {
      const msg = mask(report.errors?.[0]?.message?.replace(ANSI, '') ?? `Playwright exited with code ${exit}`)!;
      return { status: 'error', durationMs, hash, message: msg.slice(0, 600) };
    }
    const verdict = judge(finals, marksOf(code), mask, { exit, errors: (report.errors ?? []).map((e) => e.message ?? '').filter(Boolean) });
    const out: TestRunResult = { durationMs, hash, ...verdict };
    if (verdict.status === 'failed' && verdict.message) Object.assign(out, parseFailure(verdict.message));
    // The test that failed is the one that must pass: a test changed since (by a fix, or by hand) proves nothing about the fix.
    if (out.verified && opts.baseline && opts.baseline !== hash) {
      out.verified = false;
      out.unverified = 'The test changed since it failed, so its passing doesn’t show the bug is fixed. Run it once more to judge the test as it is now.';
    }
    return out;
  } finally {
    for (const f of [configFile, reportFile]) fs.rmSync(f, { force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

/** A run cut short (the studio stopped meanwhile) leaves its files: its configuration, and Playwright's notes, which hold the pages' addresses. Gone the next time. */
const LEFT_OVER_MS = 30 * 60_000;

export function sweepRuns(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^run-[a-z0-9]+-[0-9a-f]{6}(?:\.config\.mjs|\.json)?$/.test(n));
  } catch {
    return;
  }
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > LEFT_OVER_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

export async function installBrowser(project: Project, onLine: (line: string) => void): Promise<boolean> {
  const { code } = await run([...playwrightCli(project), 'install', 'chromium'], project.root, process.env, 10 * 60_000, onLine);
  return code === 0;
}
