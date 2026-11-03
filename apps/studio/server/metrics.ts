import fs from 'node:fs';
import path from 'node:path';
import type { MetricEvent, MetricsSummary } from '../shared/api.ts';
import type { Project } from './project.ts';

/** Medians are taken over this many of the latest values: enough for a stable figure, bounded however long it runs. */
const SAMPLES = 500;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Keep a value for a median, when it is a number (and, with `positive`, above zero). */
function sample(into: number[], v: unknown, positive = false): void {
  const n = Number(v);
  if (!Number.isFinite(n) || (positive && n <= 0)) return;
  into.push(n);
  if (into.length > SAMPLES) into.shift();
}

/**
 * How the studio is used in an app: the commands given (spoken or typed, pointing with the hand or the mouse), the
 * changes kept and undone, the tests run. Each event is appended to .saywright/metrics.jsonl in the app (exported
 * from Stats); the studio itself keeps only the counts and the latest values its Stats show.
 */
export class Metrics {
  private readonly started = Date.now();
  private readonly session = Math.random().toString(36).slice(2, 10);
  private n = { commands: 0, voice: 0, typed: 0, hand: 0, mouse: 0, unpointed: 0, changes: 0, answers: 0, quick: 0, ai: 0, kept: 0, undone: 0, testsRun: 0, testsPassed: 0 };
  private latencies: number[] = [];
  private words: number[] = [];
  private decisions: number[] = [];

  constructor(private project: Project) {}

  private get file(): string {
    return path.join(this.project.stateDir(), 'metrics.jsonl');
  }

  record(event: MetricEvent): void {
    const e = { ...event, at: event.at ?? Date.now(), session: this.session };
    this.count(e);
    try {
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    } catch {
      /* metrics must never break the tool */
    }
  }

  private count(e: MetricEvent): void {
    const n = this.n;
    if (e.type === 'command') {
      n.commands++;
      if (e.input === 'voice') n.voice++;
      else if (e.input === 'typed') n.typed++;
      if (e.pointer === 'hand') n.hand++;
      else if (e.pointer === 'mouse') n.mouse++;
      else if (!e.pointer || e.pointer === 'none') n.unpointed++;
      if (e.result === 'change') {
        n.changes++;
        sample(this.latencies, e.latencyMs);
      } else if (e.result === 'answer') n.answers++;
      if (e.source === 'quick') n.quick++;
      else if (e.source === 'ai' || e.source === 'claude' || e.source === 'fake') n.ai++;
      sample(this.words, e.words, true);
    } else if (e.type === 'decision') {
      if (e.decision === 'kept') n.kept++;
      else if (e.decision === 'undone') n.undone++;
      sample(this.decisions, e.decisionMs);
    } else if (e.type === 'test') {
      n.testsRun++;
      if (e.status === 'passed') n.testsPassed++;
    }
  }

  summary(): MetricsSummary {
    const n = this.n;
    return {
      since: this.started,
      commands: n.commands,
      byInput: { voice: n.voice, typed: n.typed },
      byPointer: { hand: n.hand, mouse: n.mouse, none: n.unpointed },
      changes: n.changes,
      answers: n.answers,
      quick: n.quick,
      ai: n.ai,
      kept: n.kept,
      undone: n.undone,
      keepRate: n.kept + n.undone ? n.kept / (n.kept + n.undone) : null,
      medianLatencyMs: median(this.latencies),
      medianWords: median(this.words),
      medianDecisionMs: median(this.decisions),
      testsRun: n.testsRun,
      testsPassed: n.testsPassed,
    };
  }

  exportAll(): string {
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch {
      return '';
    }
  }
}
