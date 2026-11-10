/**
 * The budget tells the truth: a call that was stopped or failed after it was sent is counted, an answer without
 * usage is counted at the estimate (never as free), a provider's numbers are read as numbers, a price that isn't
 * one is no price, the connection check is held to the budget, and the usage files survive a crash. In each case a
 * budget set to stop stays a hard limit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConnectionView, Usage } from '../../shared/ai';
import { count } from '../../server/ai/llm/types';
import type { ChatModel, ChatRequest, ChatResult } from '../../server/ai/llm/types';
import { AiService } from '../../server/ai/service';
import { AgentError } from '../../server/ai/types';
import { UsageLedger } from '../../server/ai/usage';

const used = (input: number, output: number): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-truth-'));

function service(chat: ChatModel, models: ConnectionView['models'] = [], model = 'claude-sonnet-5-5'): AiService {
  const dataDir = tmp();
  const ai = new AiService({ dataDir, envDir: dataDir, mcp: null as never, origin: () => '', app: () => null, appNames: () => ({}) });
  const connection = { id: 'c', kind: chat.kind, label: 'C', auth: 'key', status: 'ready', models } as unknown as ConnectionView;
  ai.connections.route = () => ({ connection, model });
  ai.connections.chatModel = () => chat;
  ai.connections.refresh = async () => undefined;
  ai.connections.get = () => connection;
  return ai;
}

function model(answer: (req: ChatRequest) => Promise<ChatResult> | ChatResult, kind: ChatModel['kind'] = 'anthropic'): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return { kind, model: 'claude-sonnet-5-5', vision: true, calls, chat: async (req) => (calls.push(req), answer(req)) };
}

const BIG = 'word '.repeat(20_000);
const report = (ai: AiService) => ai.json({ task: 'report', feature: 'report', system: 'Return JSON.', parts: [{ type: 'text', text: BIG }], schema: z.object({ ok: z.boolean() }), name: 'report', maxTokens: 1000 });
const today = (ai: AiService) => ai.usage.totals().today;
const entries = (ai: AiService) => ai.usage.summary();

/** Calls until the budget refuses one (at most 60): how many went out, and the refusal. */
async function untilRefused(call: () => Promise<unknown>): Promise<{ sent: number; refusal: AgentError }> {
  for (let sent = 0; sent < 60; sent++) {
    try {
      await call();
    } catch (err) {
      if (err instanceof AgentError && err.code === 'budget') return { sent, refusal: err };
    }
  }
  throw new Error('never refused');
}

describe('a call that was stopped or failed after it was sent', () => {
  it('is counted at the estimate, marked as one; a stop budget refuses once they add up to it', async () => {
    const chat = model(() => {
      throw Object.assign(new AgentError('Stopped.', 'aborted'), { sent: true });
    });
    const ai = service(chat);
    ai.usage.setBudget({ dailyUsd: 0.5, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await expect(report(ai)).rejects.toMatchObject({ code: 'aborted' });
    expect(today(ai).calls).toBe(1);
    expect(today(ai).input).toBeGreaterThan(20_000);
    expect(today(ai).usd).toBeGreaterThan(0);
    expect(entries(ai).estimated).toBe(1);
    const { refusal } = await untilRefused(() => report(ai));
    expect(refusal.message).toMatch(/daily budget/);
    expect(today(ai).usd).toBeLessThanOrEqual(0.5);
  });

  it('is counted with what the provider said it used, when it said', async () => {
    const chat = model(() => {
      throw Object.assign(new AgentError('The connection to Anthropic was lost while it was answering. Try again.', 'network'), { sent: true, partial: used(5000, 40) });
    });
    const ai = service(chat);
    await expect(report(ai)).rejects.toMatchObject({ code: 'network' });
    expect(today(ai)).toMatchObject({ calls: 1, input: 5000, output: 40 });
    expect(entries(ai).estimated).toBe(0);
  });

  it('is not counted when it never reached the provider', async () => {
    const ai = service(model(() => Promise.reject(new AgentError('Can’t reach Ollama. Check the address and your connection.', 'network'))));
    await expect(report(ai)).rejects.toMatchObject({ code: 'network' });
    expect(today(ai).calls).toBe(0);
  });
});

describe('an answer without usage, and numbers that aren’t numbers', () => {
  it('a missing usage is counted at the estimate, never as free, and a stop budget still refuses in time', async () => {
    const chat = model(() => ({ text: '{"ok":true}', calls: [], stop: 'end', usage: used(0, 0), model: 'claude-sonnet-5-5', raw: null }));
    const ai = service(chat);
    await report(ai);
    expect(today(ai).input).toBeGreaterThan(20_000);
    expect(today(ai).output).toBeGreaterThan(0);
    expect(today(ai).usd).toBeGreaterThan(0);
    expect(entries(ai).estimated).toBe(1);
    ai.usage.setBudget({ dailyUsd: 0.5, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await untilRefused(() => report(ai));
    expect(today(ai).usd).toBeLessThanOrEqual(0.5);
  });

  it('provider counts are read as numbers; negatives and nonsense are dropped', () => {
    expect([count('50'), count(100), count(-3), count(NaN), count(Infinity), count(null), count({}), count('x')]).toEqual([50, 100, 0, 0, 0, 0, 0, 0]);
  });
});

describe('a price that isn’t one', () => {
  it('a negative listed price is no price: nothing is recorded below zero, and a stop budget still stops', async () => {
    const chat = model(() => ({ text: '{"ok":true}', calls: [], stop: 'end', usage: used(30_000, 20), model: 'openrouter/auto', raw: null, usd: -0.5 }), 'compatible');
    const ai = service(chat, [{ id: 'openrouter/auto', label: 'Auto', price: { input: -1_000_000, output: -1_000_000 } }] as unknown as ConnectionView['models'], 'openrouter/auto');
    ai.usage.setBudget({ dailyUsd: 5, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    // Counted at the dearest rates known (an estimate), so the limit is reached and never passed.
    const { sent } = await untilRefused(() => report(ai));
    expect(sent).toBeGreaterThan(0);
    const s = entries(ai);
    expect(s.today.usd).toBeGreaterThan(0);
    expect(s.today.usd).toBeLessThanOrEqual(5);
    expect(s.estimated).toBe(sent);
    expect(s.today.unpriced).toBe(0);
    expect(s.byModel.every((r) => r.usd >= 0)).toBe(true);
  });
});

describe('the connection check', () => {
  it('is held to the budget like any call, and counted', async () => {
    const chat = model(() => ({ text: 'OK', calls: [], stop: 'end', usage: used(12, 1), model: 'claude-sonnet-5-5', raw: null }));
    const ai = service(chat, [{ id: 'claude-sonnet-5-5', label: 'Sonnet', tier: 'fast' }] as unknown as ConnectionView['models']);
    ai.usage.setBudget({ dailyUsd: 0, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    const r = await ai.test('c');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Your daily budget is \$0\.00/);
    expect(chat.calls).toHaveLength(0);
    ai.usage.setBudget({ dailyUsd: 1, mode: 'stop' });
    expect((await ai.test('c')).ok).toBe(true);
    expect(today(ai).calls).toBe(1);
  });
});

describe('the usage files', () => {
  it('a line cut short by a crash doesn’t take the next call with it', () => {
    const dir = tmp();
    const ledger = new UsageLedger(dir);
    const e = { t: Date.now(), app: null, feature: 'edit', connection: 'c', kind: 'anthropic' as const, model: 'm', plan: false, ...used(10, 10), usd: 0.01 };
    ledger.record(e);
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
    fs.appendFileSync(path.join(dir, file), '{"t":12,"inp');
    ledger.record(e);
    expect(new UsageLedger(dir).totals().today.calls).toBe(2);
  });

  it('a damaged budget file keeps a stop and its limit, and says so; values of the wrong kind are not taken', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'state.json'), '{"budget":{"dailyUsd":2,"monthlyUsd":50,"dailyTokens":null,"mode":"stop","warnAt":0.8},"resetTo');
    const ledger = new UsageLedger(dir);
    expect(ledger.budget).toMatchObject({ dailyUsd: 2, mode: 'stop' });
    expect(ledger.summary().notice).toMatch(/damaged.*still set to stop/);
    // Under it, a call that could cost more than what is left is refused.
    expect(ledger.hold({ input: 1_000_000, maxTokens: 1000, minTokens: 1000, price: { input: 3, output: 15 }, billed: true })).toHaveProperty('refused');

    const dir2 = tmp();
    fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({ budget: { dailyUsd: '2', monthlyUsd: -5, mode: 'stop' } }));
    const l2 = new UsageLedger(dir2);
    expect(() => l2.summary()).not.toThrow();
    expect(l2.budget).toMatchObject({ dailyUsd: 5, monthlyUsd: 50, mode: 'stop' });
  });
});
