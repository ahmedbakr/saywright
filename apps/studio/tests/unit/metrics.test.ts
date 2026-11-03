/**
 * Stats: every command, decision and test run is counted, the medians come from the latest values, and each event
 * goes to the app's metrics.jsonl, while the studio itself keeps only what Stats show, however long it runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Metrics } from '../../server/metrics';
import { Project } from '../../server/project';

const app = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-metrics-'));
  return { dir, metrics: new Metrics(new Project(dir, 'http://localhost:5173', dir)) };
};

describe('Stats', () => {
  it('counts commands by how they were given and what came of them, and decisions and test runs', () => {
    const { dir, metrics } = app();
    metrics.record({ type: 'command', text: 'make it bigger', words: 3, input: 'voice', pointer: 'hand', result: 'change', source: 'quick', latencyMs: 40 });
    metrics.record({ type: 'command', text: 'why is this red', words: 4, input: 'typed', pointer: 'mouse', result: 'answer', source: 'ai', latencyMs: 900 });
    metrics.record({ type: 'command', text: 'fix it', input: 'button', result: 'change', source: 'fake', latencyMs: 300, fix: true });
    metrics.record({ type: 'decision', decision: 'kept', decisionMs: 2000 });
    metrics.record({ type: 'decision', decision: 'undone', decisionMs: 4000 });
    metrics.record({ type: 'test', status: 'passed' });
    metrics.record({ type: 'test', status: 'failed' });
    expect(metrics.summary()).toMatchObject({
      commands: 3,
      byInput: { voice: 1, typed: 1 },
      byPointer: { hand: 1, mouse: 1, none: 1 },
      changes: 2,
      answers: 1,
      quick: 1,
      ai: 2,
      kept: 1,
      undone: 1,
      keepRate: 0.5,
      medianLatencyMs: 170,
      medianWords: 4,
      medianDecisionMs: 3000,
      testsRun: 2,
      testsPassed: 1,
    });
    expect(fs.readFileSync(path.join(dir, 'metrics.jsonl'), 'utf8').trim().split('\n')).toHaveLength(7);
  });

  it('takes medians over the latest values, and keeps every count, after many thousands of commands', () => {
    const { metrics } = app();
    for (let i = 0; i < 5000; i++) metrics.record({ type: 'command', text: 'x', words: 2, input: 'typed', result: 'change', source: 'quick', latencyMs: i < 4000 ? 10 : 99 });
    const s = metrics.summary();
    expect(s.commands).toBe(5000);
    expect(s.changes).toBe(5000);
    // The latest 1,000 took 99 ms each.
    expect(s.medianLatencyMs).toBe(99);
  });
});
