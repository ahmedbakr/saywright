/**
 * A budget set to stop is a hard limit for every call the studio makes: each turn of a change, each report, and calls
 * made at the same time. The stand-in model here answers with all the room it is given, at Claude Sonnet 5.5's
 * price, so nothing stays under a limit by luck.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConnectionView } from '../../shared/ai';
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

function service(chat: ChatModel, auth: ConnectionView['auth'] = 'key'): AiService {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-budget-'));
  const ai = new AiService({ dataDir, envDir: dataDir, mcp: null as never, origin: () => '', app: () => null, appNames: () => ({}) });
  const connection = { id: 'claude', kind: 'anthropic', label: 'Claude', auth, status: 'ready', models: [] } as unknown as ConnectionView;
  ai.connections.route = () => ({ connection, model: 'claude-sonnet-5-5' });
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
