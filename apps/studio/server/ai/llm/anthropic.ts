/**
 * Claude through the Anthropic API (the official SDK). Prompt caching is on
 * where a prompt is sent again: the system prompt of the coding agent (the
 * same for every request about the same app) and of Autopilot (the same every
 * turn) is cached explicitly, and the agent's conversation is cached as it
 * grows (each step re-reads the steps before it at a tenth of the price or
 * less). One-off requests (reports, reviews, translations) cache nothing:
 * writing a cache costs a quarter more than reading the prompt once. Every model
 * that can decline gets the server-side fallback (see FALLBACK), so a declined
 * request is retried on another model instead of failing.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Usage } from '../../../shared/ai.ts';
import { AgentError } from '../types.ts';
import { count, lostWhileAnswering, said, stoppedAnswering, timing, type ChatModel, type ChatRequest, type ChatResult, type Msg, type ToolCall } from './types.ts';

type Client = Pick<Anthropic, 'beta'>;

/**
 * Models whose safety classifiers can decline a request (`stop_reason: "refusal"`) and that the server-side fallback
 * can run again on another model, per Anthropic's model reference. Claude Haiku 5.5 can decline too but has no
 * server-side fallback; Claude Mythos 5 runs no classifiers.
 */
const FALLBACK = new Set(['claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** What Anthropic's error body says (the SDK parses it): its type and its message. */
function bodyOf(err: InstanceType<typeof Anthropic.APIError>): { type: string; message: string } {
  const e = (err.error as { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown } | undefined) ?? {};
  const inner = e.error && typeof e.error === 'object' ? e.error : e;
  return { type: typeof inner.type === 'string' ? inner.type : '', message: typeof inner.message === 'string' ? said(inner.message) : '' };
}

function anthropicError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new AgentError('Stopped.', 'aborted');
  if (err instanceof Anthropic.APIConnectionError) return new AgentError('Can’t reach Anthropic. Check your internet connection.', 'network');
  if (err instanceof Anthropic.APIError) {
    // Sentences for the commonest failures; never the body itself.
    const { type, message } = bodyOf(err);
    if (/credit balance/i.test(message)) return new AgentError('Your Anthropic account is out of credit. Add credit in the Anthropic Console (Plans & Billing), or route the work elsewhere in Settings → AI.', 'rate');
    if (/prompt is too long|too many tokens|context (window|length)/i.test(message)) return new AgentError('This request is too long for the model. Ask about a smaller part of the page, with fewer elements picked.', 'invalid');
    if (type === 'overloaded_error' || err.status === 529) return new AgentError('Anthropic is overloaded right now. Try again in a minute.', 'rate');
    if (err.status === 402) return new AgentError('Anthropic needs a payment on this account before it takes requests. Check Plans & Billing in the Anthropic Console.', 'rate');
    if (err.status === 413 || type === 'request_too_large') return new AgentError('The request was too large for Anthropic. Ask about a smaller part of the page, with fewer elements picked.', 'invalid');
    if (err instanceof Anthropic.AuthenticationError) return new AgentError('Anthropic rejected the API key. Update it in Settings → AI.', 'auth');
    if (err instanceof Anthropic.PermissionDeniedError) return new AgentError('This Anthropic key can’t use that model. Pick another in Settings → AI.', 'auth');
    if (err instanceof Anthropic.NotFoundError) return new AgentError('That model isn’t available to this Anthropic key. Pick another in Settings → AI.', 'invalid');
    if (err instanceof Anthropic.RateLimitError) return new AgentError('Claude is rate limited right now. Try again in a moment.', 'rate');
    if (err instanceof Anthropic.BadRequestError) return new AgentError(`Claude couldn’t take that request${message ? `: ${message}` : ''}.`, 'invalid');
    if (err instanceof Anthropic.InternalServerError || type === 'api_error') return new AgentError('Anthropic had a server problem. Try again.', 'other');
    return new AgentError(`Claude request failed${message ? `: ${message}` : ''}.`, 'other');
  }
  if (err instanceof Anthropic.AnthropicError && /auth|api key|credential/i.test(err.message)) return new AgentError('No Anthropic API key found. Add one in Settings → AI.', 'no-key');
  // Anything else is an answer the SDK couldn't read: a proxy or captive portal answering in Anthropic's place.
  if (err instanceof SyntaxError || /JSON|chunks|stream/i.test(err instanceof Error ? err.message : '')) return new AgentError('Anthropic’s answer couldn’t be read: something between this computer and Anthropic (a proxy, a captive portal, or ANTHROPIC_BASE_URL) answered instead. Check it and try again.', 'network');
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

/**
 * A turn's content as it stands once the server has switched models part-way through it (a `fallback` block marks
 * where). What the model that declined left before the switch, other than its words, is not part of the answer: the
 * model that took over can't read its thinking and never finished its tool calls. Those blocks are neither acted on
 * nor sent back with the next request, which the API would refuse.
 */
function answered<T extends { type: string }>(content: T[]): T[] {
  let at = -1;
  for (let i = content.length - 1; i >= 0 && at < 0; i--) if (content[i].type === 'fallback') at = i;
  return at < 0 ? content : content.filter((b, i) => i >= at || b.type === 'text');
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
    let partial: Usage | undefined;
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
      if (typeof s.on === 'function')
        s.on('connect', beat).on('streamEvent', (ev) => {
          beat();
          // What the stream has counted so far: written down if it fails before its end.
          if (ev.type === 'message_start') {
            const u = ev.message.usage;
            partial = { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) };
          } else if (ev.type === 'message_delta' && partial) partial = { ...partial, output: count(ev.usage.output_tokens) };
        });
      msg = await s.finalMessage();
    } catch (err) {
      // Once the stream began, what it counted is known and is written down; a request stopped before then may
      // still have been read, and is counted at its estimate.
      const known = (e: AgentError) => Object.assign(e, { partial, sent: began || !!req.signal?.aborted || idle || undefined });
      if (req.signal?.aborted) throw known(new AgentError('Stopped.', 'aborted'));
      if (idle) throw known(stoppedAnswering('Anthropic'));
      const e = anthropicError(err);
      // A stream that broke after it began (not an error Anthropic answered with) is a lost connection.
      if (began && !(err instanceof Anthropic.APIError && (err.status || err.error)) && (e.code === 'other' || e.code === 'network')) throw known(lostWhileAnswering('Anthropic'));
      throw began ? known(e) : e;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
    const calls: ToolCall[] = [];
    const text: string[] = [];
    const content = answered(msg.content);
    for (const b of content) {
      if (b.type === 'text') text.push(b.text);
      else if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> });
    }
    const u = msg.usage;
    // Each attempt as billed (a declined one, then the fallback model's): the top-level usage is only the last one's.
    const attempts = (u.iterations ?? []).map((it) => ({
      model: ('model' in it && it.model) || msg.model,
      usage: { input: count(it.input_tokens), output: count(it.output_tokens), cacheRead: count(it.cache_read_input_tokens), cacheWrite: count(it.cache_creation_input_tokens) },
    }));
    return {
      text: text.join('\n').trim(),
      calls,
      stop: msg.stop_reason === 'tool_use' ? 'tools' : msg.stop_reason === 'max_tokens' ? 'length' : msg.stop_reason === 'refusal' ? 'refusal' : 'end',
      usage: {
        input: count(u.input_tokens),
        output: count(u.output_tokens),
        cacheRead: count(u.cache_read_input_tokens),
        cacheWrite: count(u.cache_creation_input_tokens),
      },
      model: msg.model,
      raw: content,
      ...(attempts.length > 1 ? { attempts } : {}),
    };
  }
}
