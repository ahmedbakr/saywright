/**
 * Types shared by the studio client and its local API server.
 */
import type { SourceFrame, SourceHint } from '@saywright/vite/protocol';
import type { AppEnv, Framework } from './apps.ts';

/** An element the user referred to ("this", "that", a pin, the selection). */
export interface RefInfo {
  /** Which word or gesture produced it: "this", "that", "pin", "selection". */
  role: string;
  src: string | null;
  name: string;
  label: string;
  text: string;
  tag?: string;
  /** When the page didn't say where it was written: what finds it in the code. */
  hint?: SourceHint;
  /** Where React's development build says it came from, for the studio's server to map. */
  frames?: SourceFrame[];
  /** `src` was found by searching the code for the element's text and attributes: likely, not certain. */
  guessed?: boolean;
  /** How many elements on the page its code draws (a list's rows, a component's uses), when more than one. */
  same?: number;
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  created: boolean;
}

type ChangeStatus = 'preview' | 'kept' | 'undone';
/** Who made a change: an offline quick edit, an AI model ("claude" in changes made before other providers), or the tests' stand-in. */
export type ChangeSource = 'quick' | 'ai' | 'claude' | 'fake';

export interface Change {
  id: string;
  title: string;
  summary?: string;
  said?: string;
  refs?: RefInfo[];
  source: ChangeSource;
  model?: string;
  files: DiffFile[];
  status: ChangeStatus;
  createdAt: number;
  decidedAt?: number;
  /** How long it took from request to preview, in ms. */
  latencyMs?: number;
}

/**
 * Where a request that stops short goes from here: a refusal says why and offers its way forward. ask-ai: the same
 * words to the AI, past the quick edits; connect-ai: Settings → AI; link-folder: link the app's code folder; open:
 * that code (file:line:col) in the editor.
 */
/** `retry`: ask the same again (a file it changes was saved while it was being made, so it wasn’t written). */
export type NextStep = { kind: 'ask-ai' } | { kind: 'connect-ai' } | { kind: 'link-folder' } | { kind: 'open'; src: string } | { kind: 'retry' };

export type IntentResult =
  | { kind: 'change'; change: Change }
  | { kind: 'answer'; text: string; source: ChangeSource; model?: string; latencyMs: number }
  | { kind: 'message'; text: string; tone: 'info' | 'warn' | 'error'; next?: NextStep[] }
  | { kind: 'needs-key'; text: string; next?: NextStep[] };

import type { AiEffort, UsagePill } from './ai.ts';
export type { AiEffort };

export interface StatusResponse {
  version: string;
  /** The open app (null: none yet, show the app list). */
  app: { id: string; name: string; env: AppEnv; envs: AppEnv[]; framework: Framework | null; icon: string | null; sample: boolean } | null;
  target: {
    /** Its code on this computer (null for an app linked by URL alone). */
    root: string | null;
    /** Where it runs. */
    url: string;
    /** What the studio's frame loads: the app, or the studio's proxy in front of it. */
    frameUrl: string;
    name: string;
    hasConfig: boolean;
    components: string[];
    git: boolean;
    hasCode: boolean;
  };
  /** Show the app list when the studio opens. */
  launcher: boolean;
  /** The quick-start tour was taken or skipped on this computer. */
  tourSeen: boolean;
  /** An app being opened (started) right now. */
  opening: { id: string; env: string } | null;
  ai: {
    /** Something can make changes. */
    ready: boolean;
    /** The connection that does changes ("fake" in the automated tests). */
    source: string | null;
    /** Who does changes, in words. */
    who: { connection: string; label: string; model: string; plan: boolean } | null;
    effort: AiEffort;
    usage: UsagePill;
  };
  tests: {
    playwright: boolean;
  };
}

export interface RecordedStep {
  /** `url`: the page the step before it led to, waited for (a click that navigates, whatever comes next). */
  kind: 'click' | 'fill' | 'press' | 'goto' | 'note' | 'url';
  locator?: string;
  value?: string;
  /** A secret typed into the field: the name its test reads it under (PASSWORD, from SAYWRIGHT_SECRET_PASSWORD). `value` is empty. */
  secret?: string;
  /** A choice in a list: what each option chosen says (several, in a list that takes more than one). */
  select?: string[];
  /** The same options' values, when the app's bridge said them. */
  values?: string[];
  /** Another option of the list says the same as one chosen: the options are chosen by their values. */
  byValue?: boolean;
  /** A checkbox or radio button: check or uncheck it. */
  checked?: boolean;
  key?: string;
  url?: string;
  description: string;
}

export interface Expectation {
  locator: string;
  description: string;
  expected: string;
  /** What the element showed when the expectation was spoken. */
  actual: string;
  /** How many steps came before it: it is checked after them. Without it (an older studio), after the last step. */
  after?: number;
  /**
   * What it was said about is a field (its value is checked), a list (the option chosen is: `expected` is what that
   * option says), a checkbox, radio button or switch (whether it is checked: `expected` is “checked” or “not checked”),
   * an image (its accessible name is checked), or a state any element has (`state`: `expected` is “visible”,
   * “hidden”, “enabled”, “disabled”, “selected” or “not selected”).
   */
  field?: 'value' | 'select' | 'checked' | 'name' | 'state';
  /** “this shouldn't show $51.71”: the value must not be there. */
  not?: boolean;
  /** How long the tester waited (ms) after the step before it, before saying it: the check waits as long, within limits. */
  waited?: number;
  /** Words the element didn't show as it was said, in any case: compared without case (“free shipping”). */
  anyCase?: boolean;
}

/** One step or check of a generated test, as a run reported it. */
export interface RunStep {
  /** As the test names it: “[2] Click the “Apply” button”, “[check 1] The total should show $80.80”. */
  title: string;
  check: boolean;
  ok: boolean;
  error?: string;
}

export interface TestRunResult {
  status: 'passed' | 'failed' | 'error' | 'setup-needed';
  durationMs: number;
  message?: string;
  expected?: string;
  received?: string;
  output?: string;
  /**
   * What the run shows. `verified`: it passed, on its first try, with every step and check the test has reported as
   * run, and the test is the one it was compared with (unchanged since it failed): the only pass that proves something.
   */
  verified?: boolean;
  /** Why a pass doesn't prove anything (skipped, a step or check that didn't run, the test changed since it failed). */
  unverified?: string;
  /** A failure at a check (the bug shows) or at a step before the checks (the test couldn't get there: not reproduced). */
  /**
   * Where it failed: at a check (the bug shows), at a step before the checks (it doesn't show the bug yet), at a check
   * that couldn't find what it looks at (`find`), or at a check that held on screen as it was said (`replay`: the test
   * doesn't replay what was done, so it isn't the bug).
   */
  failedAt?: 'check' | 'step' | 'find' | 'replay';
  /** The steps and checks the run reported, in order. */
  steps?: RunStep[];
  /** The test's steps and checks: how many it has, and how many ran and passed. */
  counts?: { steps: number; checks: number; stepsPassed: number; checksPassed: number };
  /** The test file's fingerprint when it ran: a later run compares with it, to know the test is the same. */
  hash?: string;
  /** Secrets the test types that aren't set (setup-needed): by name, PASSWORD. */
  missingSecrets?: string[];
}

export interface MetricEvent {
  type: string;
  at?: number;
  [key: string]: unknown;
}

/** What the studio has measured since it started (Stats). */
export interface MetricsSummary {
  since: number;
  commands: number;
  byInput: { voice: number; typed: number };
  byPointer: { hand: number; mouse: number; none: number };
  changes: number;
  answers: number;
  quick: number;
  ai: number;
  kept: number;
  undone: number;
  /** Share of previews kept on the first try. */
  keepRate: number | null;
  medianLatencyMs: number | null;
  medianWords: number | null;
  medianDecisionMs: number | null;
  testsRun: number;
  testsPassed: number;
}

/** What the Inspector shows for an element: where it is written, its props and the code around it. */
export interface InspectResult {
  name: string;
  file: string;
  line: number;
  col: number;
  absPath: string;
  props: { name: string; value: string; dynamic: boolean; options?: string[] }[];
  snippet: { start: number; lines: string[]; focus: number };
  designSystem: boolean;
  /** Found by searching the code for what the page shows: likely, not certain. */
  guessed?: boolean;
}

/** The languages the studio's own speech recognition (narration, Arabic voice) works in. */
export type SpeechLang = 'ar' | 'en';

/** The speech engine on this computer and its models. */
export interface SpeechStatus {
  /** ok: models can run; missing: the runtime isn't installed for this platform; failed: it crashed. */
  runtime: 'ok' | 'missing' | 'failed' | 'starting';
  runtimeError: string;
  version: string;
  models: { id: string; label: string; langs: SpeechLang[]; sizeMb: number; wordErrors: Partial<Record<SpeechLang, number>>; installed: boolean; installing: number | null; error: string | null }[];
  /** Which model each language uses right now (null: none installed). */
  active: Record<SpeechLang, string | null>;
}

/** The most elements one request refers to: picked together in the page, sent to the studio, passed to the AI. */
export const MAX_REFS = 8;
