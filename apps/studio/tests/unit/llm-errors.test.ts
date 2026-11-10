/**
 * Provider errors in words a person can act on, never a body: Claude's commonest failures, and the shapes
 * OpenAI-compatible servers, OpenAI and Gemini answer with. A rate limit or a server problem is tried once more.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicModel } from '../../server/ai/llm/anthropic';
import { CompatibleModel } from '../../server/ai/llm/compatible';
import { GeminiModel } from '../../server/ai/llm/gemini';
import { timing, type ChatRequest } from '../../server/ai/llm/types';

type Answer = { status: number; body: string; type?: string; headers?: Record<string, string> };
let server: http.Server;
let base = '';
const answers = new Map<string, Answer[]>();
const hits = new Map<string, number>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = [...answers.keys()].find((k) => (req.url ?? '').startsWith(k));
      if (!key) return res.writeHead(404).end();
      hits.set(key, (hits.get(key) ?? 0) + 1);
      const list = answers.get(key)!;
      const a = list.length > 1 ? list.shift()! : list[0];
      res.writeHead(a.status, { 'Content-Type': a.type ?? 'application/json', ...a.headers });
      res.end(a.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
const saved = { ...timing };
afterEach(() => Object.assign(timing, saved));

const ask: ChatRequest = { system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], maxTokens: 50 };
let n = 0;
/** A compatible connection whose server answers each request with the next of `list` (the last one again after). */
const compat = (...list: Answer[]) => {
  const p = `/c${++n}`;
  answers.set(`${p}/`, list);
  return { model: new CompatibleModel('qwen3', { label: 'Mock gateway', baseUrl: `${base}${p}` }), hits: () => hits.get(`${p}/`) ?? 0 };
};
const json = (status: number, v: unknown, headers?: Record<string, string>): Answer => ({ status, body: JSON.stringify(v), headers });

describe('OpenAI-compatible errors', () => {
  it('a web page instead of an API asks about the address; a 413 page says the request was too large', async () => {
    await expect(compat({ status: 404, type: 'text/html', body: '<html><body>404 page not found</body></html>' }).model.chat(ask)).rejects.toThrow('Mock gateway answered with a web page (404), not as an API: check its address in Settings → AI. Does it end in /v1?');
    await expect(compat({ status: 413, type: 'text/html', body: '<html><h1>413 Request Entity Too Large</h1></html>' }).model.chat(ask)).rejects.toThrow(/^The request was too large for Mock gateway\. Ask about a smaller part/);
  });

  it('a FastAPI “detail” is read; a sentence never ends in two full stops', async () => {
    await expect(compat(json(422, { detail: [{ msg: 'field required' }] })).model.chat(ask)).rejects.toThrow('Mock gateway couldn’t take that request: field required.');
    await expect(compat(json(400, { error: { message: 'Please check your plan and billing details.' } })).model.chat(ask)).rejects.toThrow('Mock gateway couldn’t take that request: Please check your plan and billing details.');
  });

  it('a 200 that carries only an error says the provider’s words', async () => {
    await expect(compat(json(200, { error: { message: 'Upstream timed out', code: 502 } })).model.chat(ask)).rejects.toThrow('Mock gateway couldn’t answer: Upstream timed out.');
  });

  it('a model that writes its tool calls as text is said to be unable to call tools', async () => {
    const { model } = compat(json(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '<tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</tool_call>' } }] }));
    await expect(model.chat({ ...ask, tools: [{ name: 'read_file', description: 'd', parameters: {} }] })).rejects.toThrow('qwen3 wrote its tool calls as text instead of making them: it can’t call tools. Pick another model in Settings → AI.');
  });

  it('a rate limit is tried once more after the pause it asks for; a server problem twice in a row is reported', async () => {
    const ok = json(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Fine.' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const limited = compat(json(429, { error: { message: 'slow down' } }, { 'retry-after': '1' }), ok);
    const started = Date.now();
    expect((await limited.model.chat(ask)).text).toBe('Fine.');
    expect(limited.hits()).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const down = compat(json(503, { error: { message: 'down' } }, { 'retry-after': '0' }));
    await expect(down.model.chat(ask)).rejects.toThrow('Mock gateway had a server problem. Try again.');
    expect(down.hits()).toBe(2);

    // A pause longer than the studio waits for isn't waited for.
    timing.retryMaxMs = 500;
    const long = compat(json(429, { error: { message: 'quota' } }, { 'retry-after': '60' }));
    await expect(long.model.chat(ask)).rejects.toThrow('Mock gateway is rate limited or out of credit right now: quota. Try again in a moment.');
    expect(long.hits()).toBe(1);
  });
});

describe('Gemini errors', () => {
  it('a key Gemini doesn’t accept leads to updating the key', async () => {
    answers.set('/gem/', [json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })]);
    await expect(new GeminiModel('g', () => 'bad', `${base}/gem`).chat(ask)).rejects.toMatchObject({ code: 'auth', message: 'Gemini rejected the API key. Update it in Settings → AI.' });
  });
});

describe('Claude errors', () => {
  const claude = (path: string, a: Answer) => {
    answers.set(`${path}/v1/messages`, [a]);
    return new AnthropicModel('claude-haiku-5-5', () => new Anthropic({ apiKey: 'k', baseURL: `${base}${path}`, maxRetries: 0 }));
  };
  const err = (status: number, type: string, message: string) => json(status, { type: 'error', error: { type, message }, request_id: 'req_1' });

  it('each common failure gets its own sentence, and no body is ever shown', async () => {
    const cases: [Answer, RegExp][] = [
      [err(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), /^Your Anthropic account is out of credit\./],
      [err(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'), /^This request is too long for the model\./],
      [err(402, 'billing_error', 'Payment required'), /^Anthropic needs a payment on this account/],
      [err(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.'), /^The request was too large for Anthropic\./],
      [err(400, 'invalid_request_error', 'max_tokens: must be positive.'), /^Claude couldn’t take that request: max_tokens: must be positive\.$/],
    ];
    let i = 0;
    for (const [a, want] of cases) {
      const e = await claude(`/a${i++}`, a)
        .chat(ask)
        .catch((x: Error) => x);
      expect(e.message).toMatch(want);
      expect(e.message).not.toMatch(/\{|request_id|\.\.$/);
    }
  });

  it('an overloaded error in mid-stream says so, not the event', async () => {
    const start = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`;
    const error = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`;
    const e = await claude('/ov', { status: 200, type: 'text/event-stream', body: start + error })
      .chat(ask)
      .catch((x: Error) => x);
    expect(e.message).toBe('Anthropic is overloaded right now. Try again in a minute.');
  });
});
