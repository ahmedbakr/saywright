/**
 * The model adapters against stand-ins that speak each provider's wire
 * format (no real calls): what is sent (tools, caching, effort, structured
 * output, the model's own turns sent back), what is read (text, tool calls,
 * usage with cache reads apart), and the agent loop on top of them.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelAgent } from '../../server/ai/agent';
import { AnthropicModel } from '../../server/ai/llm/anthropic';
import { CompatibleModel } from '../../server/ai/llm/compatible';
import { GeminiModel } from '../../server/ai/llm/gemini';
import { OpenAIModel } from '../../server/ai/llm/openai';
import { dropNulls, jsonSchemaOf, strictSchema, unwatched, type Admit, type ChatModel, type ChatResult } from '../../server/ai/llm/types';
import { jsonFrom } from '../../server/ai/service';
import { ReportSchema } from '../../server/sessions/report';
import { costOf, modelInfo, sameModel } from '../../shared/models';
import { tempShop } from './helpers';

/** No budget watching. */
const free: Admit = (call) => unwatched(call.maxTokens);
/** What each call used, written down, with no budget. */
const watch =
  (into: ChatResult[]): Admit =>
  (call) => ({ maxTokens: call.maxTokens, fallback: true, settle: (r) => void (r && into.push(r)) });

type Handler = (body: Record<string, unknown>, req: http.IncomingMessage) => unknown;
let server: http.Server;
let base = '';
const routes = new Map<string, Handler>();
const seen: { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = req.url ?? '';
      seen.push({ path, body, headers: req.headers });
      const h = [...routes.entries()].find(([p]) => path.startsWith(p))?.[1];
      if (!h) {
        res.statusCode = 404;
        return res.end('{}');
      }
      const out = h(body, req);
      if (typeof out === 'number') {
        res.statusCode = out;
        return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const last = (path: string) => [...seen].reverse().find((s) => s.path.startsWith(path))!;

/** A project file edit the stand-ins propose: the shop's coupon bug. */
const EDIT = { path: 'src/lib/pricing.ts', old_string: 'const discount = round2((subtotal + shipping) * rate);', new_string: 'const discount = round2(subtotal * rate);' };

describe('OpenAI (Responses API)', () => {
  it('sends tools, effort, the cache key and no storage; reads calls and usage with cached tokens apart', async () => {
    let step = 0;
    routes.set('/openai/responses', (body) => {
      step++;
      if (step === 1) {
        return {
          model: 'gpt-6.1-sol-2026-09-01',
          output: [
            { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
            { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'read_file', arguments: '{"path":"src/lib/pricing.ts"}' },
          ],
          usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 4000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } },
        };
      }
      // The second step carries the first step's items back, then the tool's output.
      const input = body.input as { type?: string; call_id?: string; output?: string }[];
      expect(input.some((i) => i.type === 'reasoning')).toBe(true);
      expect(input.find((i) => i.type === 'function_call_output')?.call_id).toBe('call_a');
      expect(input.find((i) => i.type === 'function_call_output')?.output).toContain('discount');
      return {
        model: 'gpt-6.1-sol-2026-09-01',
        output: [{ type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'propose_change', arguments: JSON.stringify({ title: 'Discount covers items only', summary: 's', edits: [EDIT] }) }],
        usage: { input_tokens: 6000, input_tokens_details: { cached_tokens: 5000 }, output_tokens: 100 },
      };
    });
    const used: ChatResult[] = [];
    const model = new OpenAIModel('gpt-6.1-sol', () => 'sk-test', `${base}/openai`);
    const agent = new ModelAgent(model, 'high', { admit: watch(used) });
    const out = await agent.run({ text: 'fix the total', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    expect(out.kind).toBe('change');
    const req = seen.find((s) => s.path.startsWith('/openai/responses'))!;
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.body.store).toBe(false);
    expect(req.body.include).toEqual(['reasoning.encrypted_content']);
    expect(req.body.reasoning).toEqual({ effort: 'high' });
    expect(String(req.body.prompt_cache_key)).toMatch(/^saywright-/);
    expect((req.body.tools as { name: string }[]).map((t) => t.name)).toEqual(['read_file', 'search_code', 'list_files', 'propose_change']);
    expect(used[0].usage).toEqual({ input: 1000, output: 300, cacheRead: 4000, cacheWrite: 0, reasoning: 200 });
  });

  it('asks for strict JSON and says plainly when the key is wrong', async () => {
    routes.set('/openai-json/responses', () => ({ model: 'm', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":"x","b":null}' }] }], usage: { input_tokens: 10, output_tokens: 5 } }));
    const schema = z.object({ a: z.string(), b: z.string().optional() });
    const r = await jsonFrom(new OpenAIModel('gpt-6-luna', () => 'k', `${base}/openai-json`), { system: 's', parts: [{ type: 'text', text: 'go' }], schema, name: 'thing', maxTokens: 100 }, free);
    expect(r.value).toEqual({ a: 'x' });
    const format = (last('/openai-json/responses').body.text as { format: { type: string; strict: boolean; schema: { required: string[]; additionalProperties: boolean } } }).format;
    expect(format.type).toBe('json_schema');
    expect(format.strict).toBe(true);
    expect(format.schema.required).toEqual(['a', 'b']);
    expect(format.schema.additionalProperties).toBe(false);

    routes.set('/openai-bad/responses', () => 401);
    await expect(new OpenAIModel('gpt-6-luna', () => 'k', `${base}/openai-bad`).chat({ system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], maxTokens: 5 })).rejects.toThrow(/OpenAI rejected the API key/);
    await expect(new OpenAIModel('gpt-6-luna', () => undefined, `${base}/openai-bad`).chat({ system: 's', messages: [], maxTokens: 5 })).rejects.toThrow(/No OpenAI API key/);
  });
});

describe('Gemini', () => {
  it('sends the key in its header, declarations as JSON Schema, and its own turns back with their signatures', async () => {
    let step = 0;
    routes.set('/gemini/models/gemini-4-argon:streamGenerateContent', (body) => {
      step++;
      if (step === 1) {
        return {
          modelVersion: 'gemini-4-argon-001',
          candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ thought: true, text: 'thinking', thoughtSignature: 'sig1' }, { functionCall: { id: 'c1', name: 'read_file', args: { path: 'src/lib/pricing.ts' } }, thoughtSignature: 'sig2' }] } }],
          usageMetadata: { promptTokenCount: 3000, cachedContentTokenCount: 2000, candidatesTokenCount: 50, thoughtsTokenCount: 120 },
        };
      }
      const contents = body.contents as { role: string; parts: { thoughtSignature?: string; functionResponse?: { id: string; name: string; response: { output: string } } }[] }[];
      expect(contents[1].role).toBe('model');
      expect(contents[1].parts.map((p) => p.thoughtSignature)).toEqual(['sig1', 'sig2']);
      expect(contents[2].parts[0].functionResponse).toMatchObject({ id: 'c1', name: 'read_file' });
      return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { id: 'c2', name: 'propose_change', args: { title: 't', summary: 's', edits: [EDIT] } } }] } }], usageMetadata: { promptTokenCount: 3500, candidatesTokenCount: 80 } };
    });
    const used: ChatResult[] = [];
    const agent = new ModelAgent(new GeminiModel('gemini-4-argon', () => 'AIza-test', `${base}/gemini`), 'low', { admit: watch(used) });
    const out = await agent.run({ text: 'fix the total', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    expect(out.kind).toBe('change');
    const req = seen.find((s) => s.path.startsWith('/gemini/'))!;
    expect(req.headers['x-goog-api-key']).toBe('AIza-test');
    expect((req.body.systemInstruction as { parts: { text: string }[] }).parts[0].text).toContain('coding agent');
    const decl = (req.body.tools as { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[])[0].functionDeclarations;
    expect(decl.map((d) => d.name)).toContain('propose_change');
    expect(decl[0].parametersJsonSchema).toBeTruthy();
    expect((req.body.generationConfig as { thinkingConfig: unknown }).thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    // Thoughts bill as output; cached prompt tokens apart.
    expect(used[0].usage).toEqual({ input: 1000, output: 170, cacheRead: 2000, cacheWrite: 0, reasoning: 120 });
  });

  it('reports a blocked answer as declined', async () => {
    routes.set('/gemini-block/models/m:streamGenerateContent', () => ({ candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [] } }] }));
    const agent = new ModelAgent(new GeminiModel('m', () => 'k', `${base}/gemini-block`), 'low', {}, 'Gemini');
    await expect(agent.run({ text: 'x', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined })).rejects.toThrow(/Gemini declined/);
  });
});

describe('OpenAI-compatible providers', () => {
  it('speaks Chat Completions with tool messages, and takes the cost OpenRouter reports', async () => {
    let step = 0;
    routes.set('/or/chat/completions', (body) => {
      step++;
      const messages = body.messages as { role: string; tool_call_id?: string; content?: string }[];
      expect(messages[0].role).toBe('system');
      if (step === 1) return { model: 'anthropic/claude-sonnet-5-5', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search_code', arguments: '{"query":"discount"}' } }] } }], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 }, cost: 0.0021 } };
      expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 't1' });
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'The discount is applied in src/lib/pricing.ts:32.' } }], usage: { prompt_tokens: 1000, completion_tokens: 20 } };
    });
    const used: ChatResult[] = [];
    const model = new CompatibleModel('anthropic/claude-sonnet-5-5', { label: 'OpenRouter', baseUrl: `${base}/or`, key: () => 'sk-or', openrouter: true });
    const out = await new ModelAgent(model, 'medium', { admit: watch(used) }).run({ text: 'where is the discount applied?', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    expect(out).toEqual({ kind: 'answer', text: 'The discount is applied in src/lib/pricing.ts:32.' });
    expect(used[0].usd).toBe(0.0021);
    expect(used[0].usage).toEqual({ input: 300, output: 40, cacheRead: 600, cacheWrite: 0, reasoning: 0 });
    const req = seen.find((s) => s.path.startsWith('/or/'))!;
    expect(req.body.usage).toEqual({ include: true });
    expect(req.headers['x-title']).toBe('Saywright');
  });

  it('a provider without JSON schemas is asked for plain JSON, and gets one chance to repair it', async () => {
    let step = 0;
    routes.set('/ds/chat/completions', () => {
      step++;
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: step === 1 ? '{"title": 3}' : '```json\n{"title":"ok"}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    });
    const model = new CompatibleModel('deepseek-v4-flash', { label: 'DeepSeek', baseUrl: `${base}/ds`, key: () => 'k', jsonSchema: false });
    const r = await jsonFrom(model, { system: 'Write it.', parts: [{ type: 'text', text: 'go' }], schema: z.object({ title: z.string() }), name: 'x', maxTokens: 50 }, free);
    expect(r.value).toEqual({ title: 'ok' });
    const first = seen.find((s) => s.path.startsWith('/ds/'))!;
    expect(first.body.response_format).toEqual({ type: 'json_object' });
    expect(String((first.body.messages as { content: string }[])[0].content)).toContain('JSON Schema');
    const second = last('/ds/');
    expect(JSON.stringify(second.body.messages)).toContain('doesn\'t match the required format');
  });

  it('a local server needs no key, and an unreachable one says so', async () => {
    const model = new CompatibleModel('qwen', { label: 'Ollama', baseUrl: 'http://127.0.0.1:9' });
    await expect(model.chat({ system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], maxTokens: 5 })).rejects.toThrow(/Can’t reach Ollama/);
  });
});

describe('Anthropic', () => {
  it('caches the system prompt and the growing conversation, and sends Claude’s own turns back as they came', async () => {
    const calls: Record<string, unknown>[] = [];
    const replies = [
      { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'src/lib/pricing.ts' } }], usage: { input_tokens: 50, output_tokens: 80, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900 } },
      { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'propose_change', input: { title: 't', summary: 's', edits: [EDIT] } }], usage: { input_tokens: 30, output_tokens: 60, cache_read_input_tokens: 4900, cache_creation_input_tokens: 200 } },
    ];
    const client = { beta: { messages: { stream: (p: Record<string, unknown>) => (calls.push(JSON.parse(JSON.stringify(p))), { finalMessage: async () => replies[calls.length - 1] }) } } };
    const used: ChatResult[] = [];
    const agent = new ModelAgent(new AnthropicModel('claude-opus-5-5', () => client as never), 'medium', { admit: watch(used) });
    const out = await agent.run({ text: 'fix the total', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    expect(out.kind).toBe('change');
    expect(calls[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((calls[0].system as { cache_control: unknown }[])[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(calls[0].output_config).toEqual({ effort: 'medium' });
    expect(calls[0].fallbacks).toBe('default');
    expect((calls[0].tools as { name: string; input_schema: unknown }[]).find((t) => t.name === 'propose_change')?.input_schema).toBeTruthy();
    const second = calls[1].messages as { role: string; content: { type: string; signature?: string; tool_use_id?: string }[] }[];
    expect(second[1].content[0]).toMatchObject({ type: 'thinking', signature: 'sig' });
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1' });
    expect(used[0].usage).toEqual({ input: 50, output: 80, cacheRead: 4000, cacheWrite: 900 });
  });

  it('writes no cache for a one-off request, and only the system prompt for one that is sent again every turn', async () => {
    const sent: Record<string, unknown>[] = [];
    const client = { beta: { messages: { stream: (p: Record<string, unknown>) => (sent.push(JSON.parse(JSON.stringify(p))), { finalMessage: async () => ({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 9, output_tokens: 3 } }) }) } } };
    const chat = new AnthropicModel('claude-sonnet-5-5', () => client as never);
    const req = { system: 'You write reports.', parts: [{ type: 'text' as const, text: 'The session…' }], schema: z.object({ ok: z.boolean() }), name: 'r', maxTokens: 100 };
    // A report, a review or a translation: read once, so a cache would only cost more.
    await jsonFrom(chat, req, free);
    expect(sent[0].cache_control).toBeUndefined();
    expect(JSON.stringify(sent[0])).not.toContain('cache_control');
    // Autopilot: the same system prompt every turn, a new page each time.
    await jsonFrom(chat, { ...req, cache: 'system' }, free);
    expect((sent[1].system as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sent[1].cache_control).toBeUndefined();
    expect(JSON.stringify(sent[1].messages)).not.toContain('cache_control');
  });

  it('a wrong edit goes back to the model with the reason, and the corrected one is taken', async () => {
    const bad = { ...EDIT, old_string: 'const discount = nothing;' };
    let n = 0;
    const replies = [bad, EDIT].map((e, i) => ({ model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `p${i}`, name: 'propose_change', input: { title: 't', summary: 's', edits: [e] } }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const sent: Record<string, unknown>[] = [];
    const client = { beta: { messages: { stream: (p: Record<string, unknown>) => (sent.push(p), { finalMessage: async () => replies[n++] }) } } };
    const out = await new ModelAgent(new AnthropicModel('claude-haiku-5-5', () => client as never), 'low').run({ text: 'fix', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    expect(out.kind).toBe('change');
    const back = (sent[1].messages as { content: { type: string; is_error?: boolean; content?: string }[] }[]).at(-1)!.content[0];
    expect(back).toMatchObject({ type: 'tool_result', is_error: true });
    expect(back.content).toMatch(/was not found/);
    // Haiku has no server-side fallback.
    expect(sent[0].fallbacks).toBeUndefined();
  });

  it('stops before a call when the budget says so', async () => {
    const client = { beta: { messages: { stream: () => ({ finalMessage: async () => ({}) }) } } };
    const agent = new ModelAgent(new AnthropicModel('claude-opus-5-5', () => client as never), 'low', {
      admit: () => {
        throw new Error('Used $5.00 of your $5.00 daily budget.');
      },
    });
    await expect(agent.run({ text: 'x', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined })).rejects.toThrow(/daily budget/);
  });

  it('reads each attempt of a declined request with the model that ran it, and asks for no fallback when told not to', async () => {
    const sent: Record<string, unknown>[] = [];
    const iteration = (type: string, model: string, output: number) => ({ type, model, input_tokens: 100, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null });
    const replies = [
      // Opus 5.5 declined after 300 tokens, and Opus 4.8 answered: the top-level usage is only its attempt.
      {
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: 'It is $78.40.' }],
        usage: { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [iteration('message', 'claude-opus-5-5', 300), iteration('fallback_message', 'claude-opus-4-8', 1000)] },
      },
      { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It is $78.40.' }], usage: { input_tokens: 100, output_tokens: 20, iterations: [iteration('message', 'claude-opus-5-5', 20)] } },
    ];
    const client = { beta: { messages: { stream: (p: Record<string, unknown>) => (sent.push(JSON.parse(JSON.stringify(p))), { finalMessage: async () => replies[sent.length - 1] }) } } };
    const chat = new AnthropicModel('claude-opus-5-5', () => client as never);
    const ask = { system: 's', messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'What is the total?' }] }], maxTokens: 2000 };
    const first = await chat.chat(ask);
    expect(chat.fallback).toBe(true);
    expect(sent[0]).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(first).toMatchObject({ text: 'It is $78.40.', model: 'claude-opus-4-8', usage: { input: 100, output: 1000, cacheRead: 0, cacheWrite: 0 } });
    expect(first.attempts).toEqual([
      { model: 'claude-opus-5-5', usage: { input: 100, output: 300, cacheRead: 0, cacheWrite: 0 } },
      { model: 'claude-opus-4-8', usage: { input: 100, output: 1000, cacheRead: 0, cacheWrite: 0 } },
    ]);
    // Under a budget set to stop: no second attempt is asked for, and one attempt needs no list.
    const second = await chat.chat({ ...ask, fallback: false });
    expect(sent[1].fallbacks).toBeUndefined();
    expect(sent[1].betas).toBeUndefined();
    expect(second.attempts).toBeUndefined();
    expect(new AnthropicModel('claude-haiku-5-5').fallback).toBe(false);
  });
});

describe('structured output schemas', () => {
  it('the report schema becomes strict for OpenAI-style providers (closed objects, every field required, optional ones nullable)', () => {
    const s = strictSchema(jsonSchemaOf(ReportSchema));
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.type === 'object' && o.properties) {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
      Object.values(o).forEach(walk);
    };
    walk(s);
    expect(dropNulls({ a: 1, b: null, c: [{ d: null, e: 2 }] })).toEqual({ a: 1, c: [{ e: 2 }] });
  });
});

describe('prices', () => {
  it('costs a call at list price, with cache reads cheaper and Haiku’s long prompts dearer', () => {
    const opus = modelInfo('anthropic', 'claude-opus-5-5')!.price;
    expect(costOf(opus, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(4);
    expect(costOf(opus, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(0.2);
    const haiku = modelInfo('anthropic', 'claude-haiku-5-5')!.price;
    expect(costOf(haiku, { input: 50_000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.0055);
    expect(costOf(haiku, { input: 150_000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.0775);
    // A model a provider names under its own prefix is still priced.
    expect(modelInfo('compatible', 'anthropic/claude-sonnet-5-5')?.price?.input).toBe(2);
    expect(costOf(undefined, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it('knows a model under the names its provider gives it, and tells another model from it', () => {
    expect(sameModel('gpt-6.1-sol', 'gpt-6.1-sol-2026-09-30')).toBe(true);
    expect(sameModel('claude-opus-5-5', 'claude-opus-5-5-20261015')).toBe(true);
    expect(sameModel('gemini-3.8-flash', 'gemini-3.8-flash-001')).toBe(true);
    expect(sameModel('gemini-3.8-flash-preview', 'gemini-3.8-flash-preview-04-17')).toBe(true);
    expect(sameModel('anthropic/claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(true);
    expect(sameModel('gpt-5.4', 'gpt-5.4-mini')).toBe(false);
    expect(sameModel('claude-opus-5', 'claude-opus-5-5')).toBe(false);
    expect(sameModel('claude-opus-5-5', 'claude-opus-4-8')).toBe(false);
  });
});

// Keep the interface honest: every adapter is a ChatModel.
const _models: ChatModel[] = [new OpenAIModel('m', () => 'k'), new GeminiModel('m', () => 'k'), new CompatibleModel('m', { label: 'x', baseUrl: 'http://x' }), new AnthropicModel('m')];
void _models;
