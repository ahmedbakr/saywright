/**
 * Live studio state for React. High-frequency data (the replay's cursor, the mic
 * level) is drawn straight from the controller instead, so it never re-renders
 * the UI every frame.
 */
import { create } from 'zustand';
import type { ElementInfo } from '@saywright/vite/protocol';
import type { Change, Expectation, InspectResult, MetricsSummary, RecordedStep, StatusResponse, TestRunResult } from '@shared/api';
import type { Mode } from './commands';
import type { AutopilotView } from './autopilot';
import type { ReplayView } from './replay';

export type { InspectResult, MetricsSummary, Mode };

export type Tone = 'info' | 'ok' | 'warn' | 'error';

export interface IslandAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export type Island =
  | { kind: 'idle' }
  | { kind: 'listening' }
  | { kind: 'thinking' }
  | { kind: 'preview' }
  | { kind: 'answer'; text: string; said: string; model?: string; latencyMs?: number }
  | { kind: 'message'; text: string; tone: Tone; actions?: IslandAction[]; sticky?: boolean }
  | { kind: 'needs-key'; text: string; actions?: IslandAction[] };

export interface Binding {
  index: number;
  word: string;
  el: ElementInfo | null;
  via: 'pin' | 'pointing' | 'selection' | 'unresolved';
}

interface PreviewTarget {
  changeId: string;
  el: ElementInfo;
}

export interface VoiceState {
  supported: boolean;
  /** starting: the microphone is opening; finishing: working out what was said. */
  state: 'idle' | 'starting' | 'listening' | 'finishing';
  trigger: 'hold' | 'toggle' | null;
  words: string[];
  bindings: Binding[];
  error: string | null;
  /** What the last sentence was understood as, and how. */
  last: HeardSentence | null;
  /** The on-device speech model. */
  model: 'idle' | 'loading' | 'ready' | 'unavailable';
  modelError: string;
}

export interface HeardSentence {
  text: string;
  source: 'browser' | 'device' | 'command' | 'variant';
  /** The browser's guesses, best first. */
  browser: string[];
  /** Why the browser's recogniser couldn't listen, if it failed. */
  browserError: string | null;
  /** The on-device model's transcript ('' when it heard nothing or didn't run). */
  device: string;
  /** Loudest moment, 0..1 (below ~0.03 the microphone is very quiet). */
  loudness: number;
  /** From letting go to knowing what was said. */
  ms: number;
}

/** A voice request waiting in the command bar to be checked (Settings → Voice → Check before sending). */
interface Draft {
  text: string;
  alternatives: string[];
  /** Bumped for every new draft so the command bar picks it up. */
  n: number;
}

export interface RecorderState {
  startUrl: string | null;
  steps: RecordedStep[];
  expectations: Expectation[];
  spec: { path: string; code: string } | null;
  run: (TestRunResult & { at: number }) | null;
  running: boolean;
  /** What is being added for a test to run: Playwright's browser, or Playwright itself to the app. */
  installing: false | 'browser' | 'playwright';
  installLog: string[];
  /** A fix preview was made for the failing test and is being re-checked. */
  verifying: boolean;
  /** The fingerprint of the test when it last failed: a fix is checked against that test, unchanged. */
  baseline?: string;
  /** The file last written for this test (kept when a change to it asks for a new one): written again, it is replaced. */
  written?: { path: string; code: string };
  /**
   * Kept steps that end on another page than the one the app came back on (the studio or the app was reloaded): the
   * page they end on. Carrying on from here would make a test that can't replay, so the Test tab says so.
   */
  elsewhere?: string;
}

interface RequestState {
  id: string;
  text: string;
  step: string;
  detail?: string;
  startedAt: number;
  kind: 'intent' | 'fix' | 'test';
}

export type Overlay = null | 'settings' | 'palette' | 'help' | 'onboarding';
export type SettingsTab = 'general' | 'voice' | 'ai' | 'usage' | 'mcp' | 'services' | 'shortcuts';

interface StudioState {
  mode: Mode;
  status: StatusResponse | null;
  statusError: string | null;
  /** `outdated`: the app answered, but its Saywright plugin and this studio can't work together; the side to update. */
  app: { connected: boolean; url: string; title: string; reloadKey: number; outdated?: 'plugin' | 'studio' };
  pointer: 'mouse' | null;
  hover: ElementInfo | null;
  /** In Write test, what a check typed in the command bar is about: what the pointer rested on when the bar took the focus. */
  typingAbout: ElementInfo | null;
  snapped: boolean;
  selection: ElementInfo | null;
  pins: ElementInfo[];
  previewTargets: PreviewTarget[];
  /** A session's steps being replayed in the app (Replay & verify). */
  replay: ReplayView | null;
  /** Autopilot using the app: its step, and what it is doing. */
  autopilot: AutopilotView | null;
  voice: VoiceState;
  draft: Draft | null;
  island: Island;
  request: RequestState | null;
  /** Requests asked while another runs: they wait their turn (core/requests.ts). */
  waiting: { id: string; text: string }[];
  changes: Change[];
  inspect: InspectResult | null;
  inspectLoading: boolean;
  recorder: RecorderState;
  summary: MetricsSummary | null;
  overlay: Overlay;
  settingsTab: SettingsTab;
  history: string[];
  /** Focus the command input (bumped to trigger). */
  focusInput: number;
  onboardingStep: number;
}

export const initialRecorder: RecorderState = {
  startUrl: null,
  steps: [],
  expectations: [],
  spec: null,
  run: null,
  running: false,
  installing: false,
  installLog: [],
  verifying: false,
};

export const useStudio = create<StudioState>()(() => ({
  mode: 'edit',
  status: null,
  statusError: null,
  app: { connected: false, url: '', title: '', reloadKey: 0 },
  pointer: null,
  hover: null,
  typingAbout: null,
  snapped: false,
  selection: null,
  pins: [],
  previewTargets: [],
  replay: null,
  autopilot: null,
  voice: { supported: true, state: 'idle', trigger: null, words: [], bindings: [], error: null, last: null, model: 'idle', modelError: '' },
  draft: null,
  island: { kind: 'idle' },
  request: null,
  waiting: [],
  changes: [],
  inspect: null,
  inspectLoading: false,
  recorder: initialRecorder,
  summary: null,
  overlay: null,
  settingsTab: 'general',
  history: [],
  focusInput: 0,
  onboardingStep: 0,
}));

export const set = useStudio.setState;
export const get = useStudio.getState;

export const previews = (s: StudioState) => s.changes.filter((c) => c.status === 'preview');

/** Same element and same box: lets React skip re-renders while nothing moves. */
export function sameEl(a: ElementInfo | null, b: ElementInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.w === b.rect.w && a.rect.h === b.rect.h && a.src === b.src && a.text === b.text;
}
