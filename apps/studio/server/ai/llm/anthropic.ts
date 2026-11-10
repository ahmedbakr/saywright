/**
 * Claude through the Anthropic API (the official SDK). Prompt caching is on
 * where a prompt is sent again: the system prompt of the coding agent (the
 * same for every request about the same app) and of Autopilot (the same every
 * turn) is cached explicitly, and the agent's conversation is cached as it
 * grows (each step re-reads the steps before it at a tenth of the price or
 * less). One-off requests (reports, reviews, translations) cache nothing:
 * writing a cache costs a quarter more than reading the prompt once. Opus and
 * Sonnet get the server-side fallback, so a declined request is retried on
 * another model instead of failing.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AgentError } from '../types.ts';
import { lostWhileAnswering, stoppedAnswering, timing, type ChatModel, type ChatRequest, type ChatResult, type Msg, type ToolCall } from './types.ts';

type Client = Pick<Anthropic, 'beta'>;

const FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

function anthropicError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new AgentError('Stopped.', 'aborted');
  if (err instanceof Anthropic.AuthenticationError) return new AgentError('Anthropic rejected the API key. Update it in Settings → AI.', 'auth');
  if (err instanceof Anthropic.PermissionDeniedError) return new AgentError('This Anthropic key can’t use that model. Pick another in Settings → AI.', 'auth');
  if (err instanceof Anthropic.NotFoundError) return new AgentError('That model isn’t available to this Anthropic key. Pick another in Settings → AI.', 'invalid');
  if (err instanceof Anthropic.RateLimitError) return new AgentError('Claude is rate limited right now. Try again in a moment.', 'rate');
  if (err instanceof Anthropic.BadRequestError) return new AgentError(`Claude couldn’t take that request: ${err.message}`, 'invalid');
  if (err instanceof Anthropic.APIConnectionError) return new AgentError('Can’t reach Anthropic. Check your internet connection.', 'network');
  if (err instanceof Anthropic.InternalServerError) return new AgentError('Anthropic had a server problem. Try again.', 'other');
  if (err instanceof Anthropic.APIError) return new AgentError(`Claude request failed (${err.status ?? 'error'}): ${err.message}`, 'other');
  if (err instanceof Anthropic.AnthropicError && /auth|api key|credential/i.test(err.message)) return new AgentError('No Anthropic API key found. Add one in Settings → AI.', 'no-key');
  return new AgentError(err instanceof Error ? err.message : String(err), 'other');
}

function encode(messages: Msg[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.BetaMessageParam => {
    if (m.role === 'user') {
      return {
        role: 'user',
        content: m.parts.map((p) => (p.type === 'text' ? { type: 'text' as const, text: p.text } : { type: 'image' as const, source: { type: 'base64' as const, media_type: p.mime, data: p.data } })),
      };
    }
    if (m.role === 'assistant') {
      if (Array.isArray(m.raw)) return { role: 'assistant', content: m.raw as Anthropic.Beta.BetaContentBlockParam[] };
      return {
        role: 'assistant',
        content: [...(m.text ? [{ type: 'text' as const, text: m.text }] : []), ...m.calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args }))],
      };
    }
    return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.output, ...(r.error ? { is_error: true } : {}) })) };
  });
}

export class AnthropicModel implements ChatModel {
  readonly kind = 'anthropic' as const;
  readonly vision = true;

  constructor(
    readonly model: string,
    // Each attempt waits at most the idle time for the answer to begin, and is tried three times in all: a request
    // to an address that never answers ends in minutes, not a quarter of an hour.
    private client: () => Client = () => new Anthropic({ maxRetries: 2, timeout: timing.idleMs }),
  ) {}

  get fallback(): boolean {
    return FALLBACK.has(this.model);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const format = req.json ? zodOutputFormat(req.json.schema) : null;
    const params: BetaMessageStreamParams = {
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, ...(req.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) }],
      messages: encode(req.messages),
      // Automatic caching: the breakpoint follows the end of the conversation.
      ...(req.cache === 'conversation' ? { cache_control: { type: 'ephemeral' as const } } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema })) } : {}),
      output_config: { ...(req.effort ? { effort: req.effort } : {}), ...(format ? { format: { type: format.type, schema: format.schema } } : {}) },
      ...(this.fallback && req.fallback !== false ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };
    let msg: Anthropic.Beta.BetaMessage;
    // Stop, and silence: a stream with no event for `timing.idleMs` is given up on.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted) ctl.abort();
    let idle = false;
    let began = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        ctl.abort();
      }, timing.idleMs);
    };
    try {
      const s = this.client().beta.messages.stream(params, { signal: ctl.signal });
      const beat = () => {
        began = true;
        arm();
      };
      // (A stand-in client in the tests may give only the final message.)
      if (typeof s.on === 'function') s.on('connect', beat).on('streamEvent', beat);
      msg = await s.finalMessage();
    } catch (err) {
      if (req.signal?.aborted) throw new AgentError('Stopped.', 'aborted');
      if (idle) throw stoppedAnswering('Anthropic');
      const e = anthropicError(err);
      // A stream that broke after it began (not an error Anthropic answered with) is a lost connection.
      if (began && !(err instanceof Anthropic.APIError && err.status) && (e.code === 'other' || e.code === 'network')) throw lostWhileAnswering('Anthropic');
      throw e;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
    const calls: ToolCall[] = [];
    const text: string[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') text.push(b.text);
      else if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> });
    }
    const u = msg.usage;
    // Each attempt as billed (a declined one, then the fallback model's): the top-level usage is only the last one's.
    const attempts = (u.iterations ?? []).map((it) => ({
      model: ('model' in it && it.model) || msg.model,
      usage: { input: it.input_tokens ?? 0, output: it.output_tokens ?? 0, cacheRead: it.cache_read_input_tokens ?? 0, cacheWrite: it.cache_creation_input_tokens ?? 0 },
    }));
    return {
      text: text.join('\n').trim(),
      calls,
      stop: msg.stop_reason === 'tool_use' ? 'tools' : msg.stop_reason === 'max_tokens' ? 'length' : msg.stop_reason === 'refusal' ? 'refusal' : 'end',
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      model: msg.model,
      raw: msg.content,
      ...(attempts.length > 1 ? { attempts } : {}),
    };
  }
}
