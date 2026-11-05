/**
 * A budget set to stop is a hard limit for every call the studio makes: each turn of a change, each report, and calls
 * made at the same time. The stand-in model here answers with all the room it is given, at Claude Sonnet 5.5's
 * price, so nothing stays under a limit by luck. And what a call used is counted in full, at the rates of the models
 * that ran it: a declined request run again on another model counts both attempts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConnectionView, Usage } from '../../shared/ai';
import type { CallSize } from '../../server/ai/usage';
import type { ChatModel, ChatRequest, ChatResult } from '../../server/ai/llm/types';
import { AiService } from '../../server/ai/service';
import { tempShop } from './helpers';

/** A model that answers every call with as much as it may: a report's JSON, or a turn that reads more code. */
function standIn(): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    kind: 'anthropic',
    model: 'claude-sonnet-5-5',
    vision: true,
    calls,
    async chat(req): Promise<ChatResult> {
      calls.push(req);
      // Two answers asked for at once both wait here, so neither is recorded before the other is sent.
      await new Promise((r) => setTimeout(r, 20));
      const usage = { input: 1000, output: req.maxTokens, cacheRead: 0, cacheWrite: 0 };
      if (req.json) return { text: '{"ok":true}', calls: [], stop: 'end', usage, model: this.model, raw: null };
      return { text: '', calls: [{ id: `c${calls.length}`, name: 'list_files', args: {} }], stop: 'tools', usage, model: this.model, raw: undefined };
    },
  };
}

function service(chat: ChatModel, auth: ConnectionView['auth'] = 'key', model = 'claude-sonnet-5-5'): AiService {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-budget-'));
  const ai = new AiService({ dataDir, envDir: dataDir, mcp: null as never, origin: () => '', app: () => null, appNames: () => ({}) });
  const connection = { id: 'claude', kind: 'anthropic', label: 'Claude', auth, status: 'ready', models: [] } as unknown as ConnectionView;
  ai.connections.route = () => ({ connection, model });
  ai.connections.chatModel = () => chat;
  return ai;
}

const change = (ai: AiService) => ai.agent()!.run({ text: 'make the total bigger', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
const report = (ai: AiService, maxTokens: number) => ai.json({ task: 'report', feature: 'report', system: 'Return JSON.', parts: [{ type: 'text', text: 'the session' }], schema: z.object({ ok: z.boolean() }), name: 'report', maxTokens });
const spent = (ai: AiService) => ai.usage.totals().today.usd;

describe('a budget set to stop', () => {
  it('at $0, makes no paid call', async () => {
    const chat = standIn();
    const ai = service(chat);
    ai.usage.setBudget({ dailyUsd: 0, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await expect(change(ai)).rejects.toMatchObject({ code: 'budget', message: expect.stringContaining('Your daily budget is $0.00, so no paid AI requests are made.') });
    await expect(report(ai, 1000)).rejects.toMatchObject({ code: 'budget' });
    expect(chat.calls).toHaveLength(0);
  });

  it('at $0.01, never sends a call that could cost more: not a report that could cost $0.03, not a turn of a change', async () => {
    const chat = standIn();
    const ai = service(chat);
    ai.usage.setBudget({ dailyUsd: 0.01, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await expect(report(ai, 3000)).rejects.toMatchObject({ code: 'budget', message: expect.stringMatching(/^This could cost up to \$0\.03, and \$0\.01 of your \$0\.01 daily budget is left\. Raise the limit/) });
    await expect(change(ai)).rejects.toMatchObject({ code: 'budget' });
    expect(chat.calls).toHaveLength(0);
    expect(spent(ai)).toBe(0);
  });

  it('two reports at the same time can’t together go past it: the second waits for no one and is refused', async () => {
    const chat = standIn();
    const ai = service(chat);
    ai.usage.setBudget({ dailyUsd: 0.015, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    const [a, b] = await Promise.allSettled([report(ai, 1000), report(ai, 1000)]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'budget', message: expect.stringContaining('while other requests are running') } });
    expect(chat.calls).toHaveLength(1);
    expect(spent(ai)).toBeLessThanOrEqual(0.015);
  });

  it('holds every turn of a change: each answers in what is left, and the change stops before the limit is passed', async () => {
    const chat = standIn();
    const ai = service(chat);
    // Each full turn costs about $0.16 here: two fit in $0.40, a third only with less room to answer.
    ai.usage.setBudget({ dailyUsd: 0.4, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await expect(change(ai)).rejects.toMatchObject({ code: 'budget' });
    const rooms = chat.calls.map((c) => c.maxTokens);
    expect(rooms.slice(0, 2)).toEqual([16_000, 16_000]);
    expect(rooms).toHaveLength(3);
    expect(rooms[2]).toBeGreaterThanOrEqual(4000);
    expect(rooms[2]).toBeLessThan(16_000);
    expect(spent(ai)).toBeGreaterThan(0.35);
    expect(spent(ai)).toBeLessThanOrEqual(0.4);
  });

  it('counts a plan’s calls by tokens, not dollars: a $0 budget doesn’t stop them, a token limit does', async () => {
    const chat = standIn();
    const ai = service(chat, 'subscription');
    ai.usage.setBudget({ dailyUsd: 0, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await expect(report(ai, 1000)).resolves.toMatchObject({ value: { ok: true } });
    ai.usage.setBudget({ dailyTokens: 1000 });
    await expect(report(ai, 1000)).rejects.toMatchObject({ code: 'budget' });
    expect(chat.calls).toHaveLength(1);
  });

  it('only warning, sends each call as asked', async () => {
    const chat = standIn();
    const ai = service(chat);
    ai.usage.setBudget({ dailyUsd: 0, monthlyUsd: null, dailyTokens: null, mode: 'warn' });
    await expect(report(ai, 1000)).resolves.toMatchObject({ value: { ok: true } });
    expect(chat.calls.map((c) => c.maxTokens)).toEqual([1000]);
  });
});

const used = (input: number, output: number): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0 });

/**
 * Claude Opus 5.5 behind the server-side fallback: each call is answered as `answer` says (the model that answered,
 * each attempt billed), a JSON answer for a report and a question's answer for a change.
 */
function opus(answer: (req: ChatRequest) => Partial<ChatResult> = () => ({})): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    kind: 'anthropic',
    model: 'claude-opus-5-5',
    vision: true,
    fallback: true,
    calls,
    async chat(req): Promise<ChatResult> {
      calls.push(req);
      return { text: req.json ? '{"ok":true}' : 'It is $78.40.', calls: [], stop: 'end', usage: used(100, 100), model: 'claude-opus-5-5', raw: null, ...answer(req) };
    },
  };
}

/** Opus 5.5 declines after 300 tokens; Opus 4.8 answers in 1,000. What the provider reports at the top is only the last. */
const declinedThenAnswered = (): Partial<ChatResult> => ({
  model: 'claude-opus-4-8',
  usage: used(100, 1000),
  attempts: [
    { model: 'claude-opus-5-5', usage: used(100, 300) },
    { model: 'claude-opus-4-8', usage: used(100, 1000) },
  ],
});

describe('what a call used, by the models that ran it', () => {
  it('counts both attempts of a declined request that another model answered, each at its own price', async () => {
    const chat = opus(declinedThenAnswered);
    const ai = service(chat, 'key', 'claude-opus-5-5');
    ai.usage.setBudget({ dailyUsd: 1, monthlyUsd: null, dailyTokens: null, mode: 'warn' });
    await report(ai, 2000);
    // Only warning: the provider may run a declined request again.
    expect(chat.calls[0].fallback).toBe(true);
    const { today } = ai.usage.totals();
    expect({ input: today.input, output: today.output }).toEqual({ input: 200, output: 1300 });
    // $0.0004 + $0.006 at Opus 5.5's price, then $0.0005 + $0.025 at Opus 4.8's.
    expect(today.usd).toBeCloseTo(0.0319, 6);
    expect(ai.usage.summary().byModel.map((r) => r.label).sort()).toEqual(['claude-opus-4-8', 'claude-opus-5-5']);
  });

  it('under a budget set to stop, a declined request isn’t run again on another model, and says why', async () => {
    const chat = opus(() => ({ stop: 'refusal', text: '' }));
    const ai = service(chat, 'key', 'claude-opus-5-5');
    ai.usage.setBudget({ dailyUsd: 1, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await expect(report(ai, 1000)).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/^The model declined to write this\. With the budget set to stop, it isn’t tried again on another model/) });
    await expect(change(ai)).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/declined this request\. Try rephrasing it\. With the budget set to stop/) });
    expect(chat.calls.map((c) => c.fallback)).toEqual([false, false]);
    // Without a limit to keep to, or only warning, it may be.
    ai.usage.setBudget({ dailyUsd: null });
    await expect(report(ai, 1000)).rejects.toMatchObject({ message: 'The model declined to write this.' });
    ai.usage.setBudget({ dailyUsd: 1, mode: 'warn' });
    await expect(report(ai, 1000)).rejects.toMatchObject({ message: 'The model declined to write this.' });
    expect(chat.calls.map((c) => c.fallback)).toEqual([false, false, true, true]);
  });

  it('a provider that runs it again anyway is still counted in full: the limit shows as passed, and the next call waits', async () => {
    const chat = opus(() => ({ ...declinedThenAnswered(), attempts: [{ model: 'claude-opus-5-5', usage: used(100, 300) }, { model: 'claude-opus-4-8', usage: used(100, 1200) }] }));
    const ai = service(chat, 'key', 'claude-opus-5-5');
    ai.usage.setBudget({ dailyUsd: null, monthlyUsd: null, dailyTokens: 1600, mode: 'stop' });
    await report(ai, 1000);
    expect(ai.usage.totals().today).toMatchObject({ input: 200, output: 1500 });
    await expect(report(ai, 1000)).rejects.toMatchObject({ code: 'budget' });
    expect(chat.calls).toHaveLength(1);
  });

  it('prices a call at the model that answered it: another model, a dated name, or one it doesn’t know (then as the one asked)', async () => {
    const answered = ['claude-opus-4-8', 'claude-opus-5-5-20261015', 'claude-opus-9-9'];
    const chat = opus(() => ({ model: answered[chat.calls.length - 1] }));
    const ai = service(chat, 'key', 'claude-opus-5-5');
    const costs: number[] = [];
    for (let i = 0; i < answered.length; i++) {
      const before = spent(ai);
      await report(ai, 1000);
      costs.push(spent(ai) - before);
    }
    // 100 tokens in and 100 out: $0.003 at Opus 4.8's price, $0.0024 at Opus 5.5's.
    expect(costs.map((c) => +c.toFixed(6))).toEqual([0.003, 0.0024, 0.0024]);
    expect(ai.usage.totals().today.unpriced).toBe(0);
  });

  it('a model that sends more than estimated has its later calls held that much bigger, up to four times', async () => {
    const held: number[] = [];
    let times = 2.5;
    // The same report each time, so the first call held what the estimate says: it sends `times` that.
    const chat = opus(() => ({ usage: used(Math.round(held[0] * times), 10) }));
    const ai = service(chat, 'key', 'claude-opus-5-5');
    ai.usage.setBudget({ dailyUsd: 1, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    const hold = ai.usage.hold.bind(ai.usage);
    ai.usage.hold = (call: CallSize, now?: number) => (held.push(call.input), hold(call, now));
    await report(ai, 1000);
    await report(ai, 1000);
    const estimate = held[0];
    expect(held[1]).toBeGreaterThanOrEqual(Math.round(estimate * 2.5));
    expect(held[1]).toBeLessThanOrEqual(Math.round(estimate * 2.5) + 1);
    // Sending less later doesn't make it trust the estimate again; sending far more is held at most four times over.
    times = 0.5;
    await report(ai, 1000);
    expect(held[2]).toBe(held[1]);
    times = 40;
    await report(ai, 1000);
    await report(ai, 1000);
    expect(held[4]).toBe(estimate * 4);
  });
});

/** A provider other than Claude: its connection routed to `model`, answered by `chat`. */
function serviceOf(kind: string, model: string, chat: ChatModel): AiService {
  const ai = service(chat, 'key', model);
  const connection = { id: kind, kind, label: kind, auth: 'key', status: 'ready', models: [] } as unknown as ConnectionView;
  ai.connections.route = () => ({ connection, model });
  return ai;
}

/** A stand-in that answers as a provider does: 1,000 tokens in and 1,000 out, under the name `answer` gives. */
function answering(kind: ChatModel['kind'], model: string, answer: Partial<ChatResult> = {}): ChatModel {
  return {
    kind,
    model,
    vision: true,
    async chat(req): Promise<ChatResult> {
      return { text: req.json ? '{"ok":true}' : 'ok', calls: [], stop: 'end', usage: used(1000, 1000), model, raw: null, ...answer };
    },
  };
}

describe('what a call used, with other providers', () => {
  it('a model answering under its provider’s name for it (a snapshot, a maker’s prefix) is counted as the model asked for', async () => {
    const cases: [ChatModel['kind'], string, string, number][] = [
      // $2 and $10 a million; $0.75 and $3.75; Claude Sonnet 5.5's $2 and $10 through OpenRouter.
      ['openai', 'gpt-6.1-sol', 'gpt-6.1-sol-2026-09-30', 0.012],
      ['gemini', 'gemini-3.8-flash', 'gemini-3.8-flash-001', 0.0045],
      ['compatible', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5', 0.012],
    ];
    for (const [kind, asked, answered, usd] of cases) {
      const ai = serviceOf(kind, asked, answering(kind, asked, { model: answered }));
      await report(ai, 2000);
      expect(ai.usage.summary().byModel.map((r) => r.label), kind).toEqual([asked]);
      expect(spent(ai), kind).toBeCloseTo(usd, 6);
    }
  });

  it('another model answering is counted under its own name and price, and a provider’s own cost as it says', async () => {
    const ai = serviceOf('openai', 'gpt-6.1-sol', answering('openai', 'gpt-6.1-sol', { model: 'gpt-6-astra' }));
    await report(ai, 2000);
    expect(ai.usage.summary().byModel.map((r) => r.label)).toEqual(['gpt-6-astra']);
    expect(spent(ai)).toBeCloseTo(0.06, 6);
    const routed = serviceOf('compatible', 'anthropic/claude-sonnet-5-5', answering('compatible', 'anthropic/claude-sonnet-5-5', { usd: 0.0123 }));
    await report(routed, 2000);
    expect(spent(routed)).toBeCloseTo(0.0123, 6);
  });

  it('a declined request says nothing of another model where the provider has none to try', async () => {
    const ai = serviceOf('openai', 'gpt-6.1-sol', answering('openai', 'gpt-6.1-sol', { stop: 'refusal', text: '' }));
    ai.usage.setBudget({ dailyUsd: 1, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    await expect(report(ai, 1000)).rejects.toMatchObject({ code: 'refused', message: 'The model declined to write this.' });
  });
});
