/**
 * Models and prices: a provider's own model list is loaded and kept, a model can be typed, compatible providers'
 * spellings of known models get their tier and price, and a model nobody has priced is never free under a budget.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConnectionView } from '../../shared/ai';
import { modelInfo, sameModel } from '../../shared/models';
import { Connections } from '../../server/ai/connections';
import { AnthropicModel } from '../../server/ai/llm/anthropic';
import type { ChatModel, ChatResult } from '../../server/ai/llm/types';
import { AiService } from '../../server/ai/service';
import { AgentError } from '../../server/ai/types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-models-'));

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/v1/models') && req.headers['x-api-key'] === 'sk-ant-test') {
      return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2' }] }));
    }
    res.statusCode = 401;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('the model list', () => {
  it('loads a provider’s own list in the background, keeps it with its time, and shows a new model without a price', async () => {
    const dir = tmp();
    const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_BASE_URL = base;
    try {
      const c = new Connections(path.join(dir, 'ai.json'), dir);
      await c.loadModelLists('anthropic');
      const models = c.list().find((x) => x.id === 'anthropic')!.models;
      const fable = models.find((m) => m.id === 'claude-fable-5-2');
      expect(fable).toMatchObject({ label: 'Claude Fable 5.2' });
      expect(fable?.price).toBeUndefined();
      // The catalog's own entry isn't listed twice.
      expect(models.filter((m) => m.id === 'claude-opus-5-5')).toHaveLength(1);
      const cache = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')) as { anthropic: { at: number } };
      expect(cache.anthropic.at).toBeGreaterThan(0);
      // A restart shows it at once, from the cache, before any provider answers.
      expect(new Connections(path.join(dir, 'ai.json'), dir).list().find((x) => x.id === 'anthropic')!.models.some((m) => m.id === 'claude-fable-5-2')).toBe(true);
      // A provider that doesn't answer (a wrong key) keeps the last list and throws nothing.
      process.env.ANTHROPIC_API_KEY = 'wrong';
      await expect(c.loadModelLists('anthropic')).resolves.toBeUndefined();
      expect(c.list().find((x) => x.id === 'anthropic')!.models.some((m) => m.id === 'claude-fable-5-2')).toBe(true);
    } finally {
      for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.url]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a model id can be typed for a built-in provider', () => {
    const dir = tmp();
    const c = new Connections(path.join(dir, 'ai.json'), dir);
    c.addModel('openai', 'gpt-7-nova');
    expect(c.list().find((x) => x.id === 'openai')!.models.some((m) => m.id === 'gpt-7-nova')).toBe(true);
  });

  it('a compatible provider’s spelling of a known model gets its tier and price', () => {
    expect(modelInfo('compatible', 'anthropic/claude-opus-5.5')).toMatchObject({ tier: 'top', price: { input: 4, output: 20 } });
    expect(modelInfo('compatible', 'openai/gpt-6.1-sol')).toMatchObject({ tier: 'top', price: { input: 2 } });
    expect(modelInfo('compatible', 'Anthropic/Claude-Sonnet-5.5')?.tier).toBe('balanced');
    expect(sameModel('claude-opus-5-5', 'anthropic/claude-opus-5.5')).toBe(true);
    expect(sameModel('claude-opus-5', 'claude-opus-5-5')).toBe(false);
  });

  it('every Claude model that can decline asks for the server-side fallback; one that has none doesn’t', () => {
    for (const m of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']) expect(new AnthropicModel(m).fallback).toBe(true);
    expect(new AnthropicModel('claude-haiku-5-5').fallback).toBe(false);
  });
});

describe('a model nobody has priced', () => {
  it('is counted at its provider’s dearest known rates, as an estimate, so a stop limit isn’t passed', async () => {
    const dir = tmp();
    const chat: ChatModel = {
      kind: 'anthropic',
      model: 'claude-fable-5-2',
      vision: true,
      chat: async (): Promise<ChatResult> => ({ text: '{"ok":true}', calls: [], stop: 'end', usage: { input: 100_000, output: 2000, cacheRead: 0, cacheWrite: 0 }, model: 'claude-fable-5-2', raw: null }),
    };
    const ai = new AiService({ dataDir: dir, envDir: dir, mcp: null as never, origin: () => '', app: () => null, appNames: () => ({}) });
    const connection = { id: 'anthropic', kind: 'anthropic', label: 'Anthropic API', auth: 'key', status: 'ready', models: [{ id: 'claude-fable-5-2', label: 'Claude Fable 5.2' }] } as unknown as ConnectionView;
    ai.connections.route = () => ({ connection, model: 'claude-fable-5-2' });
    ai.connections.chatModel = () => chat;
    ai.usage.setBudget({ dailyUsd: 0.5, monthlyUsd: null, dailyTokens: null, mode: 'stop' });
    const report = () => ai.json({ task: 'report', feature: 'report', system: 'Return JSON.', parts: [{ type: 'text', text: 'the session' }], schema: z.object({ ok: z.boolean() }), name: 'report', maxTokens: 2000 });
    // 100,000 in and 2,000 out at Claude Fable 5.1's $10/$50 (the dearest Claude rates known): $1.10 a call.
    await report();
    const t = ai.usage.totals().today;
    expect(t.unpriced).toBe(0);
    expect(t.usd).toBeCloseTo(1.1, 2);
    expect(ai.usage.summary().estimated).toBe(1);
    await expect(report()).rejects.toBeInstanceOf(AgentError);
    expect(ai.usage.totals().today.calls).toBe(1);
  });
});
