/**
 * One conversation turn with any model, in the studio's own terms. Each
 * provider adapter turns these into its wire format and back, so the agent
 * loop, the report writer and the usage ledger don't care who answers.
 */
import { z } from 'zod';
import type { AiEffort, ProviderKind, Usage } from '../../../shared/ai.ts';
import { AgentError, type AgentErrorCode } from '../types.ts';

type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Part = { type: 'text'; text: string } | { type: 'image'; mime: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };

export type Msg =
  | { role: 'user'; parts: Part[] }
  /** `raw`: the provider's own form of the turn, sent back as is (thinking signatures and reasoning items must survive). */
  | { role: 'assistant'; text: string; calls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: { id: string; name: string; output: string; error?: boolean }[] };

export interface ChatRequest {
  system: string;
  messages: Msg[];
  tools?: ToolDef[];
  /** Answer with JSON matching this schema (validated by the caller). */
  json?: { name: string; schema: z.ZodType };
  maxTokens: number;
  effort?: AiEffort;
  signal?: AbortSignal;
  /** Groups requests that share a prompt prefix, for providers that route caching by key. */
  cacheKey?: string;
  /**
   * What later requests send again, for providers that charge to write a cache: the system prompt (Autopilot's
   * turns), or the conversation as it grows (a tool loop). Left out for a one-off request, which would pay to
   * write a cache nobody reads.
   */
  cache?: 'system' | 'conversation';
  /**
   * Whether a request the model declines may be run again on another model by the provider (Claude's server-side
   * fallback). Off under a budget set to stop: that second attempt's cost can't be set aside before it is sent.
   */
  fallback?: boolean;
}

export interface ChatResult {
  text: string;
  calls: ToolCall[];
  stop: 'end' | 'tools' | 'length' | 'refusal';
  usage: Usage;
  /** The model that answered, as the provider names it. */
  model: string;
  raw: unknown;
  /** The cost the provider itself reported (OpenRouter), in USD. */
  usd?: number;
  /**
   * Each attempt billed, when there were several (a declined one, then a fallback model's), with the model that ran
   * it: `usage` is then only the last one's.
   */
  attempts?: { model: string; usage: Usage }[];
}

/** A model call's place in the budget: the room it may answer in, held against the budget until it is settled. */
export interface Ticket {
  maxTokens: number;
  /** Whether the provider may run a declined request again on another model (see ChatRequest.fallback). */
  fallback: boolean;
  /** What the call used (written down), or null when it failed: either way, what was held for it is let go. */
  settle(res: ChatResult | null, ms?: number): void;
}

/**
 * Before each model call, with about how many tokens it sends, the most it may answer, and the least room to answer
 * it is worth sending for: its ticket. Throws when the budget says stop.
 */
export type Admit = (call: { input: number; maxTokens: number; minTokens: number }) => Ticket;

/** A ticket for a call no budget watches. */
export const unwatched = (maxTokens: number): Ticket => ({ maxTokens, fallback: true, settle: () => undefined });

export interface ChatModel {
  readonly kind: ProviderKind;
  readonly model: string;
  /** Can read screenshots. */
  readonly vision: boolean;
  /** The provider can run a request the model declines again on another model (see ChatRequest.fallback). */
  readonly fallback?: boolean;
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** Why a declined request wasn't tried on another model, when the provider could have but a budget set to stop said no. */
export function noFallback(chat: ChatModel, ticket: Ticket): string {
  return chat.fallback && !ticket.fallback ? ' With the budget set to stop, it isn’t tried again on another model, whose cost can’t be held in advance: set the budget to warn in Settings → Usage and budget to allow that.' : '';
}

/** A provider's HTTP error, in plain words, with what the person can do about it. */
function httpError(provider: string, status: number, body: string, where = 'Settings → AI'): AgentError {
  let detail = '';
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? '';
  } catch {
    detail = body.slice(0, 200);
  }
  const code: AgentErrorCode = status === 401 || status === 403 ? 'auth' : status === 404 ? 'invalid' : status === 429 ? 'rate' : status === 400 || status === 422 ? 'invalid' : 'other';
  const text =
    status === 401
      ? `${provider} rejected the API key. Update it in ${where}.`
      : status === 403
        ? `This ${provider} key can’t use that model. Pick another in ${where}.`
        : status === 404
          ? `${provider} doesn’t know that model${detail ? ` (${detail})` : ''}. Pick another in ${where}.`
          : status === 429
            ? `${provider} is rate limited or out of credit right now${detail ? `: ${detail}` : ''}.`
            : status >= 500
              ? `${provider} had a server problem. Try again.`
              : `${provider} couldn’t take that request${detail ? `: ${detail}` : ''}.`;
  return new AgentError(text, code);
}

/** fetch with the request's abort signal and a time limit; connection failures become plain-language errors. */
export async function post(provider: string, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<unknown> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (err) {
    if (signal?.aborted) throw new AgentError('Stopped.', 'aborted');
    if (ctl.signal.aborted) throw new AgentError(`${provider} took too long to answer.`, 'network');
    throw new AgentError(`Can’t reach ${provider}${err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''}. Check the address and your connection.`, 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text();
  if (!res.ok) throw httpError(provider, res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError(`${provider} sent an answer that isn’t JSON.`, 'other');
  }
}

/** The schema as plain JSON Schema (draft 2020-12), shared definitions inlined. */
export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, { reused: 'inline', unrepresentable: 'any' }) as JsonSchema;
  delete out.$schema;
  return out;
}

/** A tool call's arguments, from JSON text or an object; never throws. */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return { __invalid: raw };
  }
}

/**
 * A JSON schema in the strict subset OpenAI and Gemini accept for structured
 * output: every object closed, every property required (optional ones become
 * nullable).
 */
export function strictSchema(schema: JsonSchema): JsonSchema {
  const walk = (s: unknown): unknown => {
    if (!s || typeof s !== 'object') return s;
    if (Array.isArray(s)) return s.map(walk);
    const o = { ...(s as Record<string, unknown>) };
    delete o.$schema;
    if (o.type === 'object' && o.properties && typeof o.properties === 'object') {
      const props = o.properties as Record<string, unknown>;
      const required = new Set(Array.isArray(o.required) ? (o.required as string[]) : []);
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        const w = walk(v) as Record<string, unknown>;
        next[k] = required.has(k) ? w : nullable(w);
      }
      o.properties = next;
      o.required = Object.keys(next);
      o.additionalProperties = false;
    }
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) if (key in o) o[key] = walk(o[key]);
    return o;
  };
  return walk(schema) as JsonSchema;
}

function nullable(s: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(s.type)) return s.type.includes('null') ? s : { ...s, type: [...s.type, 'null'] };
  if (typeof s.type === 'string') return { ...s, type: [s.type, 'null'] };
  return { anyOf: [s, { type: 'null' }] };
}

/** Drop the nulls strictSchema made optional fields return, so the result reads like the original schema. */
export function dropNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(dropNulls) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null) o[k] = dropNulls(x);
    return o as T;
  }
  return v;
}
