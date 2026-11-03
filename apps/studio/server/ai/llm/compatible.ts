/**
 * Any provider that speaks OpenAI's Chat Completions API: OpenRouter, Groq,
 * DeepSeek, Mistral, xAI, Together, and models on this computer through
 * Ollama or LM Studio. Structured output asks for a JSON schema; a provider
 * that can't do that is asked for plain JSON, which the caller checks.
 */
import { AgentError } from '../types.ts';
import { jsonSchemaOf, parseArgs, post, strictSchema, type ChatModel, type ChatRequest, type ChatResult, type Msg, type ToolCall } from './types.ts';

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  refusal?: string | null;
  reasoning_content?: string | null;
}

interface CompletionBody {
  model?: string;
  choices?: { message?: ChatMessage; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    /** DeepSeek */
    prompt_cache_hit_tokens?: number;
    /** OpenRouter, with usage accounting on: dollars. */
    cost?: number;
  };
}

function encode(system: string, messages: Msg[], vision: boolean): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      const onlyText = m.parts.every((p) => p.type === 'text');
      out.push({
        role: 'user',
        content: onlyText
          ? m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
          : m.parts.flatMap((p): ContentPart[] => (p.type === 'text' ? [{ type: 'text', text: p.text }] : vision ? [{ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }] : [])),
      });
    } else if (m.role === 'assistant') {
      if (m.raw && typeof m.raw === 'object' && (m.raw as ChatMessage).role === 'assistant') {
        // Reasoning text some providers return is not sent back (DeepSeek refuses it).
        const { reasoning_content: _r, ...msg } = m.raw as ChatMessage;
        out.push(msg);
      } else {
        out.push({
          role: 'assistant',
          content: m.text || null,
          ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
        });
      }
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.error ? `Error: ${r.output}` : r.output });
    }
  }
  return out;
}

interface CompatibleOptions {
  /** Shown in errors: "OpenRouter", "Ollama"… */
  label: string;
  baseUrl: string;
  key?: () => string | undefined;
  vision?: boolean;
  /** Can return JSON matching a schema (otherwise asked for plain JSON). */
  jsonSchema?: boolean;
  /** OpenRouter: ask for the exact cost of each call. */
  openrouter?: boolean;
}

export class CompatibleModel implements ChatModel {
  readonly kind = 'compatible' as const;
  readonly vision: boolean;

  constructor(
    readonly model: string,
    private opts: CompatibleOptions,
  ) {
    this.vision = !!opts.vision;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const key = this.opts.key?.();
    const json = req.json
      ? this.opts.jsonSchema === false
        ? { response_format: { type: 'json_object' } }
        : { response_format: { type: 'json_schema', json_schema: { name: req.json.name, schema: strictSchema(jsonSchemaOf(req.json.schema)), strict: true } } }
      : {};
    const system = req.json && this.opts.jsonSchema === false ? `${req.system}\n\nAnswer with one JSON object only, matching this JSON Schema:\n${JSON.stringify(jsonSchemaOf(req.json.schema))}` : req.system;
    const body = {
      model: this.model,
      messages: encode(system, req.messages, this.vision),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      max_tokens: req.maxTokens,
      stream: false,
      ...json,
      ...(this.opts.openrouter ? { usage: { include: true } } : {}),
      ...(req.effort && this.opts.openrouter ? { reasoning: { effort: req.effort } } : {}),
    };
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
    if (this.opts.openrouter) Object.assign(headers, { 'HTTP-Referer': 'https://github.com/ahmedbakr/saywright', 'X-Title': 'Saywright' });
    const res = (await post(this.opts.label, `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, headers, body, req.signal)) as CompletionBody;

    const choice = res.choices?.[0];
    if (!choice?.message) throw new AgentError(`${this.opts.label} sent no answer.`, 'other');
    const msg = choice.message;
    const calls: ToolCall[] = (msg.tool_calls ?? []).map((c, i) => ({ id: c.id || `call_${i}`, name: c.function.name, args: parseArgs(c.function.arguments) }));
    const text = typeof msg.content === 'string' ? msg.content : (msg.content ?? []).map((c) => c.text ?? '').join('');
    const u = res.usage ?? {};
    const cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
    const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
    return {
      text: text.trim(),
      calls,
      stop: msg.refusal || choice.finish_reason === 'content_filter' ? 'refusal' : choice.finish_reason === 'length' ? 'length' : calls.length ? 'tools' : 'end',
      usage: {
        input: Math.max(0, (u.prompt_tokens ?? 0) - cacheRead - cacheWrite),
        output: u.completion_tokens ?? 0,
        cacheRead,
        cacheWrite,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      model: res.model ?? this.model,
      raw: { role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) },
      ...(typeof u.cost === 'number' ? { usd: u.cost } : {}),
    };
  }
}
