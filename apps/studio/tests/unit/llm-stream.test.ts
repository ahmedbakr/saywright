/**
 * Streamed answers, silence and Stop, against small stand-in servers: a long answer is never cut by a time limit,
 * a provider that goes quiet is given up on with a sentence that says so, Stop closes the connection at any moment,
 * and a server that won't stream gets one answer whole. Time limits are made short here; the real ones are minutes.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicModel } from '../../server/ai/llm/anthropic';
import { CompatibleModel } from '../../server/ai/llm/compatible';
import { GeminiModel } from '../../server/ai/llm/gemini';
import { OpenAIModel } from '../../server/ai/llm/openai';
import { timing, type ChatRequest } from '../../server/ai/llm/types';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => void;
let server: http.Server;
let base = '';
const routes = new Map<string, Handler>();
const seen: { path: string; body: Record<string, unknown> }[] = [];
/** Connections the studio closed before the stand-in finished answering. */
let closedEarly = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: req.url ?? '', body });
      res.on('close', () => {
        if (!res.writableFinished) closedEarly++;
      });
      const h = [...routes.entries()].find(([p]) => (req.url ?? '').startsWith(p))?.[1];
      if (!h) {
        res.statusCode = 404;
        return res.end('{}');
      }
      h(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
const saved = { ...timing };
afterEach(() => Object.assign(timing, saved));

const sse = (res: http.ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });
const send = (res: http.ServerResponse, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
const ask = (signal?: AbortSignal): ChatRequest => ({ system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], maxTokens: 50, signal });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await wait(10);
  return f();
};

describe('OpenAI-compatible, streamed', () => {
  it('asks to stream with usage, and puts text, tool calls in pieces and the usage together', async () => {
    routes.set('/c1/chat/completions', (_req, res) => {
      sse(res);
      send(res, { model: 'qwen3', choices: [{ delta: { role: 'assistant', content: 'Look' } }] });
      send(res, { choices: [{ delta: { content: 'ing.' } }] });
      send(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
      send(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }] }, finish_reason: 'tool_calls' }] });
      send(res, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } });
      res.end('data: [DONE]\n\n');
    });
    const r = await new CompatibleModel('qwen3', { label: 'Ollama', baseUrl: `${base}/c1` }).chat({ ...ask(), tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }] });
    expect(r.text).toBe('Looking.');
    expect(r.calls).toEqual([{ id: 'c1', name: 'read_file', args: { path: 'a.js' } }]);
    expect(r.stop).toBe('tools');
    expect(r.usage).toMatchObject({ input: 120, output: 30 });
    expect(r.model).toBe('qwen3');
    const sent = seen.find((s) => s.path.startsWith('/c1/'))!.body;
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it('a long answer that keeps coming is never cut; one that goes quiet is given up on, and the connection closed', async () => {
    timing.idleMs = 300;
    routes.set('/slow/chat/completions', (_req, res) => {
      sse(res);
      let n = 0;
      const t = setInterval(() => {
        send(res, { choices: [{ delta: { content: `${n} ` }, finish_reason: n === 9 ? 'stop' : null }] });
        if (++n === 10) {
          clearInterval(t);
          res.end();
        }
      }, 100);
    });
    const long = await new CompatibleModel('m', { label: 'Ollama', baseUrl: `${base}/slow` }).chat(ask());
    expect(long.text).toBe('0 1 2 3 4 5 6 7 8 9');

    routes.set('/quiet/chat/completions', (_req, res) => {
      sse(res);
      send(res, { choices: [{ delta: { content: 'Thinking' } }] });
    });
    const before = closedEarly;
    const started = Date.now();
    await expect(new CompatibleModel('m', { label: 'Ollama', baseUrl: `${base}/quiet` }).chat(ask())).rejects.toThrow(/^Ollama stopped answering: nothing came for .+\. Try again\.$/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await until(() => closedEarly > before)).toBe(true);
  });

  it('Stop works after the answer began, and closes the connection', async () => {
    routes.set('/stall/chat/completions', (_req, res) => {
      sse(res);
      send(res, { choices: [{ delta: { content: 'Half' } }] });
    });
    const ctl = new AbortController();
    const before = closedEarly;
    const p = new CompatibleModel('m', { label: 'Ollama', baseUrl: `${base}/stall` }).chat(ask(ctl.signal));
    await wait(150);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ message: 'Stopped.', code: 'aborted' });
    expect(await until(() => closedEarly > before)).toBe(true);
  });

  it('a connection that breaks mid-answer says so, not “terminated”', async () => {
    routes.set('/cut/chat/completions', (req, res) => {
      sse(res);
      send(res, { choices: [{ delta: { content: 'Half' } }] });
      setTimeout(() => req.socket.destroy(), 50);
    });
    await expect(new CompatibleModel('m', { label: 'Mock gateway', baseUrl: `${base}/cut` }).chat(ask())).rejects.toThrow('The connection to Mock gateway was lost while it was answering. Try again.');
  });

  it('a server that won’t stream gets one answer whole, and is asked that way from then on', async () => {
    let streamed = 0;
    let whole = 0;
    routes.set('/nostream/chat/completions', (_req, res, body) => {
      if (body.stream) {
        streamed++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'streaming is not supported with tools' } }));
      }
      whole++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Whole.' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
    const m = new CompatibleModel('m', { label: 'LM Studio', baseUrl: `${base}/nostream` });
    expect((await m.chat(ask())).text).toBe('Whole.');
    expect((await m.chat(ask())).text).toBe('Whole.');
    expect([streamed, whole]).toEqual([1, 2]);
    expect(seen.filter((s) => s.path.startsWith('/nostream/')).at(-1)!.body.stream).toBe(false);
  });

  it('an answer that comes whole: Stop works until its last byte, and too long a wait says what happened', async () => {
    timing.wholeMs = 300;
    let mode: 'body-stall' | 'never' = 'body-stall';
    routes.set('/whole/chat/completions', (_req, res, body) => {
      if (body.stream) {
        res.writeHead(501);
        return res.end('no');
      }
      if (mode === 'never') return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"choices": [');
    });
    const m = new CompatibleModel('m', { label: 'LM Studio', baseUrl: `${base}/whole` });
    const ctl = new AbortController();
    timing.wholeMs = 5000;
    const p = m.chat(ask(ctl.signal));
    await wait(200);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ message: 'Stopped.' });

    timing.wholeMs = 300;
    mode = 'never';
    await expect(m.chat(ask())).rejects.toThrow(/^LM Studio took longer than 0 seconds to answer/);
  });

  it('a 200 that carries an error says the provider’s words', async () => {
    routes.set('/err200/chat/completions', (_req, res) => {
      sse(res);
      send(res, { error: { message: 'Upstream provider failed.' } });
      res.end();
    });
    await expect(new CompatibleModel('m', { label: 'OpenRouter', baseUrl: `${base}/err200` }).chat(ask())).rejects.toThrow('OpenRouter couldn’t answer: Upstream provider failed.');
  });
});

describe('OpenAI and Gemini, streamed', () => {
  it('OpenAI: the response the last event carries is read; a failed one says why', async () => {
    routes.set('/oa/responses', (_req, res) => {
      sse(res);
      send(res, { type: 'response.created', response: { model: 'gpt-6-luna', output: [] } });
      send(res, { type: 'response.output_text.delta', delta: 'Hi' });
      send(res, { type: 'response.completed', response: { model: 'gpt-6-luna', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi there.' }] }], usage: { input_tokens: 10, output_tokens: 3 } } });
      res.end();
    });
    const r = await new OpenAIModel('gpt-6-luna', () => 'k', `${base}/oa`).chat(ask());
    expect(r.text).toBe('Hi there.');
    expect(seen.find((s) => s.path.startsWith('/oa/'))!.body.stream).toBe(true);

    routes.set('/oafail/responses', (_req, res) => {
      sse(res);
      send(res, { type: 'response.failed', response: { model: 'm', status: 'failed', error: { message: 'The server had an error.' }, output: [] } });
      res.end();
    });
    await expect(new OpenAIModel('m', () => 'k', `${base}/oafail`).chat(ask())).rejects.toThrow('OpenAI couldn’t answer: The server had an error.');
  });

  it('Gemini: chunks of one answer are one answer, signatures kept', async () => {
    routes.set('/gm/models/g:streamGenerateContent', (req, res) => {
      expect(req.url).toContain('alt=sse');
      sse(res);
      send(res, { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] } }], modelVersion: 'g-001' });
      send(res, { candidates: [{ content: { role: 'model', parts: [{ text: 'world.' }] } }] });
      send(res, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9 } });
      res.end();
    });
    const r = await new GeminiModel('g', () => 'k', `${base}/gm`).chat(ask());
    expect(r.text).toBe('Hello world.');
    expect(r.calls.map((c) => c.name)).toEqual(['list_files']);
    expect(r.usage).toMatchObject({ input: 40, output: 9 });
    expect(r.model).toBe('g-001');
    expect((r.raw as { parts: unknown[] }).parts).toEqual([{ text: 'Hello world.' }, { functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'sig' }]);
  });
});

describe('Anthropic, silence and broken streams', () => {
  const claude = (path: string) => new AnthropicModel('claude-haiku-5-5', () => new Anthropic({ apiKey: 'k', baseURL: `${base}${path}`, maxRetries: 0 }));
  const start = (res: http.ServerResponse) => {
    sse(res);
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 5000, output_tokens: 1 } } })}\n\n`);
  };

  it('a stream that goes quiet is given up on, and says so', async () => {
    timing.idleMs = 300;
    routes.set('/aq/v1/messages', (_req, res) => start(res));
    const started = Date.now();
    await expect(claude('/aq').chat(ask())).rejects.toThrow(/^Anthropic stopped answering/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a stream cut mid-answer is a lost connection; Stop mid-answer is Stopped', async () => {
    routes.set('/ac/v1/messages', (req, res) => {
      start(res);
      setTimeout(() => req.socket.destroy(), 50);
    });
    await expect(claude('/ac').chat(ask())).rejects.toThrow('The connection to Anthropic was lost while it was answering. Try again.');

    routes.set('/as/v1/messages', (_req, res) => start(res));
    const ctl = new AbortController();
    const p = claude('/as').chat(ask(ctl.signal));
    await wait(150);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ message: 'Stopped.' });
  });
});
