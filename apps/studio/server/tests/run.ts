import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { TestRunResult } from '../../shared/api.ts';
import { focusOn } from '../../shared/text.ts';
import { spawnProgram } from '../program.ts';

export { focusOn };
import type { Project } from '../project.ts';

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

interface PwResult {
  status: string;
  duration: number;
  error?: { message?: string };
  errors?: { message?: string }[];
}
interface PwSpec {
  tests: { results: PwResult[] }[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}

function collect(suite: PwSuite, out: PwResult[]): void {
  for (const spec of suite.specs ?? []) for (const t of spec.tests) if (t.results.length) out.push(t.results[t.results.length - 1]);
  for (const s of suite.suites ?? []) collect(s, out);
}

export function parseFailure(message: string): { expected?: string; received?: string } {
  const clean = message.replace(ANSI, '');
  const expected = /Expected (?:substring|string|pattern|value)?:?\s*"?(.*?)"?\s*$/m.exec(clean)?.[1];
  const received = /Received (?:string|value)?:?\s*"?(.*?)"?\s*$/m.exec(clean)?.[1];
  return { expected, received: focusOn(received, expected) };
}

const NEEDS_BROWSER = /Executable doesn't exist|download new browsers|npx playwright install/i;

export async function runSpec(project: Project, rel: string, baseUrl: string): Promise<TestRunResult> {
  project.resolve(rel); // refuse anything outside the project
  const started = Date.now();
  const env = { ...process.env, SAYWRIGHT_TARGET_URL: baseUrl, FORCE_COLOR: '0', CI: '1' };
  const { code, stdout, stderr } = await run([...playwrightCli(project), 'test', rel, '--reporter=json', '--workers=1'], project.root, env, 120_000);
  const durationMs = Date.now() - started;
  const all = `${stdout}\n${stderr}`;
  if (NEEDS_BROWSER.test(all)) {
    return { status: 'setup-needed', durationMs, message: 'Playwright needs its Chromium browser (one-time, about 150 MB).' };
  }
  if (/Cannot find module '@playwright\/test'|Cannot find package '@playwright\/test'/.test(all)) {
    const pm = fs.existsSync(path.join(project.root, 'pnpm-lock.yaml')) ? 'pnpm add -D' : fs.existsSync(path.join(project.root, 'yarn.lock')) ? 'yarn add -D' : fs.existsSync(path.join(project.root, 'bun.lockb')) || fs.existsSync(path.join(project.root, 'bun.lock')) ? 'bun add -d' : 'npm i -D';
    return { status: 'setup-needed', durationMs, message: `This project needs @playwright/test. Run: ${pm} @playwright/test` };
  }
  let report: { suites?: PwSuite[]; errors?: { message?: string }[] };
  try {
    report = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    return { status: 'error', durationMs, message: 'Couldn’t read the test results.', output: all.replace(ANSI, '').slice(-2000) };
  }
  const results: PwResult[] = [];
  for (const s of report.suites ?? []) collect(s, results);
  if (!results.length) {
    const msg = report.errors?.[0]?.message?.replace(ANSI, '') ?? `Playwright exited with code ${code}`;
    return { status: 'error', durationMs, message: msg.slice(0, 600) };
  }
  const failed = results.find((r) => r.status !== 'passed' && r.status !== 'skipped');
  if (!failed) return { status: 'passed', durationMs };
  const message = (failed.error?.message ?? failed.errors?.[0]?.message ?? failed.status).replace(ANSI, '');
  return { status: 'failed', durationMs, message: message.slice(0, 1200), ...parseFailure(message) };
}

export async function installBrowser(project: Project, onLine: (line: string) => void): Promise<boolean> {
  const { code } = await run([...playwrightCli(project), 'install', 'chromium'], project.root, process.env, 10 * 60_000, onLine);
  return code === 0;
}
