import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageLedger, type Hold, type UsageEntry } from '../../server/ai/usage';
import type { Price } from '../../shared/ai';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-usage-'));
const NOON = new Date(2026, 9, 15, 12, 0, 0).getTime();
/** Claude Sonnet 5.5's price, per million tokens. */
const SONNET: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

const call = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  t: NOON,
  app: 'shop',
  appName: 'Tidewell',
  feature: 'edit',
  connection: 'anthropic',
  kind: 'anthropic',
  model: 'claude-opus-5-5',
  plan: false,
  input: 1000,
  output: 500,
  cacheRead: 8000,
  cacheWrite: 0,
  usd: 0.0156,
  saved: 0.03,
  ...over,
});

describe('the usage ledger', () => {
  it('counts today and this month, plans apart from dollars, and keeps it on disk', () => {
    const d = dir();
    const l = new UsageLedger(d);
    l.record(call());
    l.record(call({ t: NOON - 86_400_000, usd: 1 }));
    l.record(call({ connection: 'claude-code', kind: 'claude-code', model: 'opus', plan: true, usd: 0.5 }));
    l.record(call({ connection: 'ollama', kind: 'compatible', model: 'qwen', usd: 0 }));
    l.record(call({ connection: 'openrouter', kind: 'compatible', model: 'odd/model', usd: null }));
    const t = new UsageLedger(d).totals(NOON);
    expect(t.today.calls).toBe(4);
    expect(t.today.usd).toBeCloseTo(0.0156);
    expect(t.today.planUsd).toBeCloseTo(0.5);
    expect(t.today.unpriced).toBe(1);
    expect(t.month.calls).toBe(5);
    expect(t.month.usd).toBeCloseTo(1.0156);
  });

  it('breaks the month down by feature, model and app, with the last 30 days and cache savings', () => {
    const l = new UsageLedger(dir());
    l.record(call());
    l.record(call({ feature: 'report', model: 'claude-sonnet-5-5', usd: 0.2, app: 'notes', appName: 'Lantern Notes' }));
    const s = l.summary(NOON, { shop: 'Tidewell shop' });
    expect(s.byFeature.map((r) => r.label)).toEqual(['Session reports', 'Changes']);
    expect(s.byModel.map((r) => r.label)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(s.byApp.map((r) => r.label)).toEqual(['Lantern Notes', 'Tidewell shop']);
    expect(s.days).toHaveLength(30);
    expect(s.days.at(-1)).toMatchObject({ date: '2026-10-15' });
    expect(s.days.at(-1)!.usd).toBeCloseTo(0.2156);
    expect(s.savedUsd).toBeCloseTo(0.06);
  });

  it('warns near a limit and, set to stop, stops at it until the limit is raised or the count reset', () => {
    const l = new UsageLedger(dir());
    l.setBudget({ dailyUsd: 1, monthlyUsd: null, mode: 'warn', warnAt: 0.8 });
    l.record(call({ usd: 0.85 }));
    expect(l.status(NOON).level).toBe('warn');
    expect(l.status(NOON).message).toBe('Used $0.85 of your $1.00 daily budget.');
    l.record(call({ usd: 0.3 }));
    expect(l.status(NOON).level).toBe('over');
    expect(l.allow(NOON).ok).toBe(true); // warn mode carries on
    l.setBudget({ mode: 'stop' });
    expect(l.allow(NOON).ok).toBe(false);
    l.setBudget({ dailyUsd: 5 });
    expect(l.allow(NOON).ok).toBe(true);
    l.setBudget({ dailyUsd: 1 });
    l.reset('today', NOON);
    expect(l.allow(NOON + 1000).ok).toBe(true);
    expect(l.totals(NOON + 1000).today.calls).toBe(0);
    // The month still counts them.
    expect(l.totals(NOON + 1000).month.calls).toBe(2);
  });

  it('a call that could go past a stopping budget isn’t sent; one that fits goes ahead, its room to answer cut to what is left', () => {
    const l = new UsageLedger(dir());
    l.setBudget({ dailyUsd: 0.5, monthlyUsd: null, mode: 'stop' });
    l.record(call({ usd: 0.47 }));
    // $0.03 left: 1,000 tokens in (at most $0.0025, written to the cache) leaves room for 2,750 tokens of answer.
    const turn = { input: 1000, maxTokens: 16_000, price: SONNET, billed: true };
    expect(l.hold({ ...turn, minTokens: 4000 }, NOON)).toEqual({ refused: 'This could cost up to $0.04, and $0.03 of your $0.50 daily budget is left.' });
    expect(l.hold({ ...turn, minTokens: 1000 }, NOON)).toMatchObject({ maxTokens: 2750 });
    // Only warning: it goes ahead as asked.
    l.setBudget({ mode: 'warn' });
    expect(l.hold({ ...turn, minTokens: 4000 }, NOON)).toMatchObject({ maxTokens: 16_000 });
  });

  it('a limit of $0 is a limit: no paid call is made, while a plan’s and a local model’s go ahead', () => {
    const l = new UsageLedger(dir());
    l.setBudget({ dailyUsd: 0, monthlyUsd: null, mode: 'stop' });
    expect(l.status(NOON).level).toBe('ok');
    const paid = { input: 500, maxTokens: 1000, minTokens: 1000, price: SONNET, billed: true };
    expect(l.hold(paid, NOON)).toEqual({ refused: 'Your daily budget is $0.00, so no paid AI requests are made.' });
    expect(l.hold({ ...paid, price: null }, NOON)).toHaveProperty('refused');
    expect(l.allow(NOON, true)).toMatchObject({ ok: false, status: { message: 'Your daily budget is $0.00, so no paid AI requests are made.' } });
    expect(l.hold({ ...paid, billed: false }, NOON)).toMatchObject({ maxTokens: 1000 });
    expect(l.allow(NOON, false).ok).toBe(true);
    // Anything spent at all is past it.
    l.record(call({ usd: 0.001 }));
    expect(l.status(NOON).level).toBe('over');
  });

  it('a limit of $0.01 never lets through a call that could cost $0.03', () => {
    const l = new UsageLedger(dir());
    l.setBudget({ dailyUsd: 0.01, monthlyUsd: null, mode: 'stop' });
    expect(l.hold({ input: 100, maxTokens: 3000, minTokens: 3000, price: SONNET, billed: true }, NOON)).toEqual({ refused: 'This could cost up to $0.03, and $0.01 of your $0.01 daily budget is left.' });
  });

  it('calls made at the same time hold their cost for each other, so together they can’t go past a limit', () => {
    const l = new UsageLedger(dir());
    l.setBudget({ dailyUsd: 0.015, monthlyUsd: null, mode: 'stop' });
    const report = { input: 10, maxTokens: 1000, minTokens: 1000, price: SONNET, billed: true };
    const first = l.hold(report, NOON);
    expect(first).toMatchObject({ maxTokens: 1000 });
    expect(l.hold(report, NOON)).toEqual({ refused: 'This could cost up to $0.01, and <$0.01 of your $0.01 daily budget is left while other requests are running.' });
    // Once the first is recorded (it used less than it could have), what is really left counts.
    l.record(call({ usd: 0.004 }));
    l.release(first as Hold);
    expect(l.hold(report, NOON)).toMatchObject({ maxTokens: 1000 });
  });

  it('a call whose price isn’t known goes ahead only while the dollar limit isn’t used up', () => {
    const l = new UsageLedger(dir());
    l.setBudget({ dailyUsd: 1, monthlyUsd: null, mode: 'stop' });
    const odd = { input: 100, maxTokens: 1000, minTokens: 1000, price: undefined, billed: true };
    const held = l.hold(odd, NOON);
    expect(held).toMatchObject({ maxTokens: 1000, usd: 0 });
    l.release(held as Hold);
    l.record(call({ usd: 1 }));
    expect(l.hold(odd, NOON)).toEqual({ refused: 'Used $1.00 of your $1.00 daily budget.' });
  });

  it('a daily token limit covers plans and local models too', () => {
    const l = new UsageLedger(dir());
    l.setBudget({ dailyUsd: null, monthlyUsd: null, dailyTokens: 10_000, mode: 'stop' });
    l.record(call({ plan: true, usd: 0.4, input: 2000, output: 1000, cacheRead: 8000 }));
    expect(l.allow(NOON).ok).toBe(false);
    expect(l.status(NOON).message).toBe('Used 11K of your 10K daily tokens.');
  });

  it('forgets everything on request', () => {
    const d = dir();
    const l = new UsageLedger(d);
    l.record(call());
    l.reset('all');
    expect(l.totals(NOON).month.calls).toBe(0);
    expect(fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
  });

  it('ignores nonsense limits', () => {
    const l = new UsageLedger(dir());
    const before = l.budget.dailyUsd;
    l.setBudget({ dailyUsd: -3 as number, warnAt: 7 });
    expect(l.budget.dailyUsd).toBe(before);
    expect(l.budget.warnAt).toBe(0.8);
  });
});
