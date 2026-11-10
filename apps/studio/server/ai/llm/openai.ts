/**
 * OpenAI through the Responses API. Nothing is stored on OpenAI's side
 * (store: false); the model's reasoning comes back encrypted and is sent back
 * on the next step, so a multi-step change keeps its train of thought. Prompt
 * caching is automatic for long prompts; a cache key per app keeps requests
 * about the same code on the same cache.
 */
import { AgentError } from '../types.ts';
import { count, jsonSchemaOf, lostWhileAnswering, parseArgs, stream, strictSchema, type ChatModel, type ChatRequest, type ChatResult, type Msg, type ToolCall } from './types.ts';

interface OutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string; refusal?: string }[];
}

interface ResponseBody {
  model: string;
  status?: string;
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output: OutputItem[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

function encode(messages: Msg[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      input.push({
        role: 'user',
        content: m.parts.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}`, detail: 'auto' })),
      });
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.raw)) input.push(...(m.raw as unknown[]));
      else {
        if (m.text) input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
        for (const c of m.calls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
      }
    } else {
      for (const r of m.results) input.push({ type: 'function_call_output', call_id: r.id, output: r.error ? `Error: ${r.output}` : r.output });
    }
  }
  return input;
}

export class OpenAIModel implements ChatModel {
  readonly kind = 'openai' as const;
  readonly vision = true;

  constructor(
    readonly model: string,
    private key: () => string | undefined,
    private baseUrl = 'https://api.openai.com/v1',
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const key = this.key();
    if (!key) throw new AgentError('No OpenAI API key yet. Add one in Settings → AI.', 'no-key');
    const body = {
      model: this.model,
      instructions: req.system,
      input: encode(req.messages),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })), parallel_tool_calls: true } : {}),
      max_output_tokens: req.maxTokens,
      ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(req.json ? { text: { format: { type: 'json_schema', name: req.json.name, schema: strictSchema(jsonSchemaOf(req.json.schema)), strict: true } } } : {}),
      ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    };
    // Streamed, so a long answer is never cut by a time limit (only silence is); the last event carries the whole response.
    let final: ResponseBody | undefined;
    let failed: string | undefined;
    const out = await stream('OpenAI', `${this.baseUrl}/responses`, { Authorization: `Bearer ${key}` }, { ...body, stream: true }, req.signal, (e) => {
      const ev = e as { type?: string; response?: ResponseBody; message?: string };
      if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') final = ev.response;
      else if (ev.type === 'error') failed = ev.message ?? 'an error';
    });
    const res = (out.whole as ResponseBody | undefined) ?? final;
    if (failed || res?.status === 'failed' || res?.error) {
      const said = (failed ?? res?.error?.message ?? '').replace(/\.+$/, '');
      throw new AgentError(`OpenAI couldn’t answer${said ? `: ${said}` : ''}.`, 'other');
    }
    if (!res) throw lostWhileAnswering('OpenAI');

    const text: string[] = [];
    const calls: ToolCall[] = [];
    let refused = false;
    for (const item of res.output ?? []) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) {
          if (c.type === 'output_text' && c.text) text.push(c.text);
          if (c.type === 'refusal') refused = true;
        }
      } else if (item.type === 'function_call' && item.call_id && item.name) {
        calls.push({ id: item.call_id, name: item.name, args: parseArgs(item.arguments) });
      }
    }
    const u = res.usage ?? {};
    const cacheRead = count(u.input_tokens_details?.cached_tokens);
    const cacheWrite = count(u.input_tokens_details?.cache_write_tokens);
    const reason = res.incomplete_details?.reason;
    return {
      text: text.join('\n').trim(),
      calls,
      stop: refused || reason === 'content_filter' ? 'refusal' : reason === 'max_output_tokens' ? 'length' : calls.length ? 'tools' : 'end',
      usage: {
        input: Math.max(0, count(u.input_tokens) - cacheRead - cacheWrite),
        output: count(u.output_tokens),
        cacheRead,
        cacheWrite,
        reasoning: count(u.output_tokens_details?.reasoning_tokens),
      },
      model: res.model ?? this.model,
      raw: res.output ?? [],
    };
  }
}
