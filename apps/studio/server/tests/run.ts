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
import type { PackageManager } from '../../shared/apps.ts';
import { focusOn } from '../../shared/text.ts';
import { installedPackage, packageManagerFor } from '../apps/detect.ts';
import { programExists, spawnProgram } from '../program.ts';
import type { Project } from '../project.ts';
import { HELD, secretsOf, STARTS_ELSEWHERE } from './generate.ts';

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
    child.stdout!.on('data', (d) => {
      stdout += d;
      // Both streams are the log: an installer says why it failed on either.
      if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.replace(ANSI, '').trim());
    });
    child.stderr!.on('data', (d) => {
      stderr += d;
      if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.replace(ANSI, '').trim());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      onLine?.(`Couldn’t start it: ${String(err)}`);
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
  title?: string;
  /** Where the test begins in its file (1-based). */
  line?: number;
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

/** A test the report lists: its title, where it begins, and its runs (retries included). */
interface PwTest {
  title: string;
  line?: number;
  results: PwResult[];
}

/** Every test's runs, in the order the report lists them. */
function collect(suite: PwSuite, out: PwTest[]): void {
  for (const spec of suite.specs ?? []) for (const t of spec.tests) out.push({ title: spec.title ?? '', line: spec.line, results: t.results });
  for (const s of suite.suites ?? []) collect(s, out);
}

export function parseFailure(message: string, title?: string): { expected?: string; received?: string } {
  const clean = message.replace(ANSI, '');
  const said = /Expected (?:substring|string|pattern|value)?:?\s*"?(.*?)"?\s*$/m.exec(clean)?.[1];
  const received = /Received (?:string|value)?:?\s*"?(.*?)"?\s*$/m.exec(clean)?.[1];
  // A check written as a pattern (a whole value, an amount): the value as the check's title says it.
  const titled = title && said && /^(?:not )?\/.*\/[a-z]*$/.test(said) ? /\bshould (?:not )?(?:show|be named|have) (.+?)(?: chosen)?$/.exec(title)?.[1] : undefined;
  const expected = titled ?? (said && plainPattern(said));
  return { expected, received: focusOn(received, expected) };
}

/** A pattern a test wrote for a value as said (/80\.80/): that value, as it was said. Any other text, as it is. */
function plainPattern(s: string): string {
  const m = /^\/(.*)\/[dgimsuy]*$/.exec(s);
  if (!m) return s;
  const text = m[1].replace(/\\(.)/g, '$1');
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') === m[1] ? text : s;
}

const NEEDS_BROWSER = /Executable doesn't exist|download new browsers|npx playwright install/i;
const FOCUSED = 'This test file has test.only (or describe.only): a run would leave its other tests out, so the studio doesn’t run it. Remove .only and run it again.';
/** A step or check of a generated test, by the mark its title starts with. */
const MARK = /^\[(\d+|check \d+)\] /;

/** A step or check as the code writes it. */
const MARK_IN_CODE = /\btest\.step\('\[(\d+|check \d+)\] /g;

/** The steps and checks a test has, as its code names them (in order). */
export function marksOf(code: string): string[] {
  return Array.from(code.matchAll(MARK_IN_CODE), (m) => m[1]);
}

/**
 * Each test's own steps and checks: those its file has from the line the test begins on to where the next one does
 * (tests made in a loop, on the same line, each have them all). Null when the report gives no place for a test.
 */
export function marksByTest(code: string, tests: { title: string; line?: number }[]): { title: string; marks: string[] }[] | null {
  if (!tests.length || tests.some((t) => typeof t.line !== 'number')) return null;
  const starts = [...new Set(tests.map((t) => t.line!))].sort((a, b) => a - b);
  const own = new Map<number, string[]>(starts.map((l) => [l, []]));
  let line = 1;
  let at = 0;
  for (const m of code.matchAll(MARK_IN_CODE)) {
    for (; at < m.index; at++) if (code.charCodeAt(at) === 10) line++;
    // A mark above every test (in a helper there) belongs to none of them: it counts for the file.
    const start = starts.findLast((l) => l <= line);
    if (start !== undefined) own.get(start)!.push(m[1]);
  }
  return tests.map((t) => ({ title: t.title, marks: own.get(t.line!)! }));
}

/**
 * The checks of a test that held on screen as they were said, by their marks (“check 2”): the studio marks them so
 * in the code it writes (see HELD). A check written or changed by hand without the mark is judged as any other.
 */
export function heldChecks(code: string): Set<string> {
  const out = new Set<string>();
  const marks = [...code.matchAll(MARK_IN_CODE)];
  marks.forEach((m, i) => {
    if (!m[1].startsWith('check ')) return;
    const body = code.slice(m.index, marks[i + 1]?.index ?? code.length);
    // Its own lines only: up to the end of its step.
    const own = body.slice(0, body.indexOf('\n  });') + 1 || undefined);
    if (own.includes(HELD)) out.add(m[1]);
  });
  return out;
}

/** A check that couldn't find what it looks at: nothing there, or more than one (Playwright's strict mode). */
const NOT_FOUND = /element\(s\) not found|strict mode violation|resolved to \d+ elements/i;

/** What a run says when the first step was sent elsewhere: “it was sent to /login”. */
export function sentElsewhere(error: string | undefined): string | null {
  if (!error || !error.includes(STARTS_ELSEWHERE)) return null;
  const url = /Received (?:string|value)?:?\s*"?(.*?)"?\s*$/m.exec(error.replace(ANSI, ''))?.[1];
  let where = url ?? '';
  try {
    const u = new URL(where);
    where = `${u.pathname}${u.search}${u.hash}`;
  } catch {
    /* as it came */
  }
  return where ? `the test didn’t get to the page it starts on: it was sent to ${where}` : 'the test didn’t get to the page it starts on';
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
 * the test has. `ended`: how Playwright itself ended. `tests`: each test's own marks (see marksByTest), in the order of
 * `results`. A pass is believed only when every test passed on its first try, every step and check reported running
 * (each test its own, as often as it has them) and none of them failed (even where the test caught the error and went
 * on), and Playwright ended cleanly.
 */
export function judge(
  results: PwResult | PwResult[],
  marks: string[],
  mask: (t: string | undefined) => string | undefined,
  ended: { exit?: number | null; errors?: string[] } = {},
  tests?: { title: string; marks: string[] }[] | null,
  held: Set<string> = new Set(),
): Pick<TestRunResult, 'status' | 'verified' | 'unverified' | 'failedAt' | 'steps' | 'counts' | 'message'> {
  const all = Array.isArray(results) ? results : [results];
  const each: RunStep[][] = all.map((r) =>
    (r.steps ?? [])
      .filter((s) => MARK.test(s.title))
      .map((s) => ({ title: mask(s.title)!, check: /^\[check /.test(s.title), ok: !s.error, error: s.error?.message ? mask(s.error.message.replace(ANSI, '').slice(0, 1200)) : undefined })),
  );
  const steps = each.flat();
  const isCheck = (m: string) => m.startsWith('check ');
  const markOf = (s: RunStep) => MARK.exec(s.title)![1];
  const tally = (list: string[]) => {
    const t = new Map<string, number>();
    for (const m of list) t.set(m, (t.get(m) ?? 0) + 1);
    return t;
  };
  // What must run where: each test its own marks, as often as it has them, so a check run twice in one test stands
  // for no other test's. Without the tests' places, every mark of the file, as often as the code has it.
  const scopes: { title?: string; wanted: Map<string, number>; ran: RunStep[] }[] = [];
  if (tests && tests.length === all.length) {
    tests.forEach((t, i) => scopes.push({ title: t.title, wanted: tally(t.marks), ran: each[i] }));
    const loose = tally(marks);
    for (const t of tests) for (const m of t.marks) loose.set(m, (loose.get(m) ?? 0) - 1);
    for (const [m, n] of loose) if (n <= 0) loose.delete(m);
    if (loose.size) scopes.push({ wanted: loose, ran: steps.filter((s) => loose.has(markOf(s))) });
  } else scopes.push({ wanted: tally(marks), ran: steps });
  // Each mark counts as passed as often as it is written where it is, however often it ran.
  const named = scopes.filter((x) => x.title !== undefined).length > 1;
  const missing: string[] = [];
  const counts = { steps: 0, checks: 0, stepsPassed: 0, checksPassed: 0 };
  for (const scope of scopes) {
    const ran = tally(scope.ran.map(markOf));
    const ok = tally(scope.ran.filter((x) => x.ok).map(markOf));
    for (const [m, n] of scope.wanted) {
      const passed = Math.min(n, ok.get(m) ?? 0);
      if (isCheck(m)) {
        counts.checks += n;
        counts.checksPassed += passed;
      } else {
        counts.steps += n;
        counts.stepsPassed += passed;
      }
      if ((ran.get(m) ?? 0) < n) missing.push(named && scope.title !== undefined ? `[${m}] in “${scope.title}”` : `[${m}]`);
    }
  }
  const bad = all.find((r) => r.status !== 'passed' && r.status !== 'skipped');
  const failing = steps.find((s) => !s.ok);
  if (!bad) {
    // A check (or step) that failed, though its test caught the error and went on: it failed all the same.
    if (failing) {
      const why = `${failing.title} failed, though the test caught the error and went on: ${failing.error ?? 'no message'}`;
      return { status: 'failed', failedAt: whereFailed(failing, held), message: why.slice(0, 1200), steps, counts };
    }
    if (all.every((r) => r.status === 'skipped')) return { status: 'error', message: 'The test was skipped, so it shows nothing.', steps, counts };
    if (!marks.length) return { status: 'passed', verified: false, unverified: 'This test has no numbered steps (an older version of Saywright wrote it, or it was written by hand), so a pass can’t show that each step and check ran. Generate it again.', steps, counts };
    if (!counts.checks) return { status: 'passed', verified: false, unverified: 'This test has no check, so a pass only shows its steps ran.', steps, counts };
    if (missing.length) return { status: 'passed', verified: false, unverified: `The test passed, but ${missing.length === 1 ? 'a step' : `${missing.length} steps`} of it didn’t report running (${missing.join(', ')}).`, steps, counts };
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
  const elsewhere = failing && !failing.check ? sentElsewhere(failing.error) : null;
  return { status: 'failed', failedAt: failing ? whereFailed(failing, held) : 'step', message: (elsewhere ? `${elsewhere[0].toUpperCase()}${elsewhere.slice(1)}. ${message}` : message).slice(0, 1200), steps, counts };
}

/**
 * Where a test failed, and so what it shows. Only a check that was said against what the screen showed, and that
 * found its element, reproduces the bug: one that couldn't find what it looks at shows nothing about it, and one that
 * held on screen as it was said shows that the test doesn't replay what was done.
 */
function whereFailed(failing: RunStep, held: Set<string>): NonNullable<TestRunResult['failedAt']> {
  if (!failing.check) return 'step';
  if (NOT_FOUND.test(failing.error ?? '')) return 'find';
  const mark = MARK.exec(failing.title)?.[1];
  return mark && held.has(mark) ? 'replay' : 'check';
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

/** Where Chrome and Edge are installed, by platform: Playwright runs them by their channel, with nothing to download. */
const INSTALLED: Record<string, { channel: 'chrome' | 'msedge'; name: string; paths: string[] }[]> = {
  darwin: [
    { channel: 'chrome', name: 'Google Chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
    { channel: 'msedge', name: 'Microsoft Edge', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
  ],
  linux: [
    { channel: 'chrome', name: 'Google Chrome', paths: ['/opt/google/chrome/chrome'] },
    { channel: 'msedge', name: 'Microsoft Edge', paths: ['/opt/microsoft/msedge/msedge'] },
  ],
  win32: [
    { channel: 'chrome', name: 'Google Chrome', paths: ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map((v) => path.join(process.env[v] ?? '', 'Google/Chrome/Application/chrome.exe')) },
    { channel: 'msedge', name: 'Microsoft Edge', paths: ['PROGRAMFILES', 'PROGRAMFILES(X86)'].map((v) => path.join(process.env[v] ?? '', 'Microsoft/Edge/Application/msedge.exe')) },
  ],
};

/**
 * The browser a run uses: the one PW_CHROMIUM_PATH names; else Playwright's own Chromium when it is installed; else an
 * installed Chrome or Edge through Playwright's channel (no download); else Playwright's own, which then asks to be
 * installed. `name` is said in the run's result.
 */
export function chooseBrowser(project: Project, platform: string = process.platform, exists: (p: string) => boolean = fs.existsSync): { executablePath?: string; channel?: 'chrome' | 'msedge'; name: string } {
  const own = process.env.PW_CHROMIUM_PATH;
  if (own) return { executablePath: own, name: `Chromium (${own})` };
  if (ownChromium(project, exists)) return { name: 'Playwright’s Chromium' };
  for (const b of INSTALLED[platform] ?? []) if (b.paths.some((p) => p && exists(p))) return { channel: b.channel, name: b.name };
  return { name: 'Playwright’s Chromium' };
}

/** Whether Playwright's own Chromium is installed, as the app's Playwright would launch it. Unknown is yes. */
function ownChromium(project: Project, exists: (p: string) => boolean): boolean {
  try {
    const req = createRequire(path.join(project.root, 'package.json'));
    const core = req(req.resolve('playwright-core', { paths: [path.dirname(req.resolve('@playwright/test/package.json'))] })) as { chromium: { executablePath(): string } };
    return exists(core.chromium.executablePath());
  } catch {
    return true;
  }
}

/**
 * Whether the app has Playwright's test runner (@playwright/test), which runs the tests the studio writes: installed
 * for it (in its folder, or its workspace's), or found from its folder as Node finds packages.
 */
export function hasPlaywright(project: Project): boolean {
  if (installedPackage(project.root, '@playwright/test')) return true;
  try {
    createRequire(path.join(project.root, 'package.json')).resolve('@playwright/test/cli');
    return true;
  } catch {
    return false;
  }
}

const ADD: Record<PackageManager, string[]> = { npm: ['install', '--save-dev'], pnpm: ['add', '-D'], yarn: ['add', '-D'], bun: ['add', '-d'] };

/** What adds Playwright to the app: the package manager that installs its packages, as a development dependency. */
export function addPlaywrightCommand(root: string): { cmd: string[]; says: string } {
  const { uses } = packageManagerFor(root);
  const cmd = [uses, ...ADD[uses], '@playwright/test'];
  return { cmd, says: cmd.join(' ') };
}

/** Said when a test can't run for want of Playwright: what it is for, and what adds it. */
function needsPlaywright(root: string): string {
  const made = fs.existsSync(path.join(root, 'package.json')) ? '' : ' This folder has no package.json: adding Playwright makes one, with node_modules beside it.';
  return `This app doesn’t have Playwright yet (@playwright/test), which runs the test. Add it here, or run in the app’s folder: ${addPlaywrightCommand(root).says}.${made}`;
}

/**
 * Add Playwright to the app with its own package manager, saying each line of what it prints. Resolves with whether
 * the app has it afterwards (a command that ends well without installing it isn't done).
 */
export async function addPlaywright(project: Project, onLine: (line: string) => void): Promise<boolean> {
  const { cmd, says } = addPlaywrightCommand(project.root);
  if (!programExists(cmd[0])) {
    onLine(`This app uses ${cmd[0]}, which isn’t installed on this computer. Install it (npm install -g ${cmd[0]}), then run in the app’s folder: ${says}`);
    return false;
  }
  onLine(`$ ${says}`);
  const { code } = await run(cmd, project.root, process.env, 10 * 60_000, onLine);
  if (code === 0 && hasPlaywright(project)) return true;
  onLine(code === 0 ? `It ended without an error, but the app still has no @playwright/test. Run it in the app’s folder: ${says}` : code === null ? `It was stopped (it took more than 10 minutes). Run it in the app’s folder: ${says}` : `It didn’t work (code ${code}). Run it in the app’s folder to see why: ${says}`);
  return false;
}

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
  // Without Playwright in the app there is nothing to run the test: said at once (npx would fetch one of its own first,
  // which the test's own import still couldn't find).
  if (!hasPlaywright(project)) return { status: 'setup-needed', durationMs: 0, hash, needs: 'playwright', message: needsPlaywright(project.root) };
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
  const browser = chooseBrowser(project);
  fs.writeFileSync(
    configFile,
    `// Written by Saywright for one run of ${js(rel)}; removed after it.
export default {
  testDir: ${js(path.dirname(file))},
  testMatch: ${js(path.basename(file))},
  outputDir: ${js(outputDir)},
  retries: 0,
  workers: 1,
  // A focused test (test.only) leaves the rest of the file out: refused, so a file is only ever judged whole.
  forbidOnly: true,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['json', { outputFile: ${js(reportFile)} }]],
${setup ? `  globalSetup: ${js(setup)},\n` : ''}  use: {
    baseURL: ${js(opts.baseUrl)},
    browserName: 'chromium',
    actionTimeout: 15000,
    navigationTimeout: 30000,
${browser.executablePath ? `    launchOptions: { executablePath: ${js(browser.executablePath)} },\n` : ''}${browser.channel ? `    channel: ${js(browser.channel)},\n` : ''}  },
};
`,
  );
  try {
    const { code: exit, stdout, stderr } = await run([...playwrightCli(project), 'test', '--config', configFile], project.root, env, 180_000);
    const durationMs = Date.now() - started;
    const all = mask(`${stdout}\n${stderr}`)!.replace(ANSI, '');
    if (NEEDS_BROWSER.test(all)) return { status: 'setup-needed', durationMs, hash, needs: 'browser', message: 'Playwright needs its Chromium browser (one-time, about 150 MB): no Chrome or Edge was found on this computer to use instead.' };
    // Found from the app's folder, but not from where the test is (a test kept outside the app's packages).
    if (/Cannot find module '@playwright\/test'|Cannot find package '@playwright\/test'/.test(all)) return { status: 'setup-needed', durationMs, hash, needs: 'playwright', message: needsPlaywright(project.root) };
    let report: PwReport;
    try {
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch {
      return { status: 'error', durationMs, hash, message: 'Couldn’t read the test results.', output: all.slice(-2000) };
    }
    const runs: PwTest[] = [];
    for (const s of report.suites ?? []) collect(s, runs);
    // Every test in the file, each by its last try: a file with a second test that fails doesn't pass.
    const ran = runs.filter((t) => t.results.length);
    const finals = ran.map((t) => t.results[t.results.length - 1]);
    if (!finals.length) {
      const msg = mask(report.errors?.[0]?.message?.replace(ANSI, '') ?? `Playwright exited with code ${exit}`)!;
      if (/forbidOnly|focused with '\.only'/.test(msg)) return { status: 'error', durationMs, hash, message: FOCUSED };
      return { status: 'error', durationMs, hash, message: msg.slice(0, 600) };
    }
    const verdict = judge(finals, marksOf(code), mask, { exit, errors: (report.errors ?? []).map((e) => e.message ?? '').filter(Boolean) }, marksByTest(code, ran), heldChecks(code));
    const out: TestRunResult = { durationMs, hash, browser: browser.name, ...verdict };
    if (verdict.status === 'failed' && verdict.message) Object.assign(out, parseFailure(verdict.message, verdict.steps?.find((s) => !s.ok)?.title));
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
  let said = false;
  const { code } = await run([...playwrightCli(project), 'install', 'chromium'], project.root, process.env, 10 * 60_000, (line) => {
    said = true;
    onLine(line);
  });
  // A failure always says why, even one that printed nothing.
  if (code !== 0 && !said) onLine(code === null ? 'The install was stopped (it took more than 10 minutes).' : `The install ended with code ${code} and said nothing more.`);
  return code === 0;
}
