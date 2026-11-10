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

/**
 * How long a provider may stay silent. A streamed answer may take as long as it likes, but no byte for `idleMs`
 * means the provider stopped answering; a request that can't be streamed gets `wholeMs` in all. Mutable for the
 * tests, which can't wait minutes.
 */
export const timing = { idleMs: 90_000, wholeMs: 5 * 60_000 };

const seconds = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`);

/** A provider's HTTP error: the sentence a person reads, and what the adapter needs to decide what to do next. */
export class ProviderHttpError extends AgentError {
  constructor(
    message: string,
    code: AgentErrorCode,
    readonly status: number,
    readonly body: string,
  ) {
    super(message, code);
  }
}

/** A provider's HTTP error, in plain words, with what the person can do about it. */
function httpError(provider: string, status: number, body: string, where = 'Settings → AI'): ProviderHttpError {
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
  return new ProviderHttpError(text, code, status, body);
}

/** Said when the connection broke after the provider had begun to answer (a Wi-Fi drop, a laptop waking up). */
export const lostWhileAnswering = (provider: string) => new AgentError(`The connection to ${provider} was lost while it was answering. Try again.`, 'network');
/** Said when a streamed answer went silent. */
export const stoppedAnswering = (provider: string) => new AgentError(`${provider} stopped answering: nothing came for ${seconds(timing.idleMs)}. Try again.`, 'network');

/**
 * One request to a provider, with the request's abort signal honoured until the last byte is read. `idle`: the
 * request fails when nothing arrives for that long (a stream); otherwise it fails when the whole answer took longer
 * than `timing.wholeMs`. Connection failures become plain-language errors.
 */
async function send(provider: string, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, idle: boolean, read: (res: Response, alive: () => void) => Promise<unknown>): Promise<unknown> {
  if (signal?.aborted) throw new AgentError('Stopped.', 'aborted');
  const ctl = new AbortController();
  let why: 'idle' | 'whole' | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (kind: 'idle' | 'whole', ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      why = kind;
      ctl.abort();
    }, ms);
  };
  const alive = idle ? () => arm('idle', timing.idleMs) : () => undefined;
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (idle) alive();
  else arm('whole', timing.wholeMs);
  let began = false;
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (err) {
      const code = err instanceof Error && err.cause && typeof err.cause === 'object' && 'code' in err.cause ? String(err.cause.code) : '';
      if (code === 'UND_ERR_HEADERS_TIMEOUT') why = 'whole';
      throw err;
    }
    began = true;
    alive();
    if (!res.ok) {
      const text = await res.text();
      throw httpError(provider, res.status, text);
    }
    return await read(res, alive);
  } catch (err) {
    if (err instanceof AgentError) throw err;
    if (signal?.aborted) throw new AgentError('Stopped.', 'aborted');
    if (why === 'idle') throw stoppedAnswering(provider);
    if (why === 'whole') throw new AgentError(`${provider} took longer than ${seconds(timing.wholeMs)} to answer. Try again, or ask for something smaller.`, 'network');
    if (began) throw lostWhileAnswering(provider);
    throw new AgentError(`Can’t reach ${provider}${err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''}. Check the address and your connection.`, 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Whatever happened, the connection to the provider is closed: nothing may go on after an answer, an error or Stop.
    ctl.abort();
  }
}

const parseJson = (provider: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError(`${provider} sent an answer that isn’t JSON.`, 'other');
  }
};

/** One request whose answer comes whole (a provider that can't stream): `timing.wholeMs` for all of it. */
export async function post(provider: string, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return send(provider, url, headers, body, signal, false, async (res) => parseJson(provider, await res.text()));
}

/**
 * One streamed request (server-sent events): each event's data, parsed, goes to `onEvent` as it arrives, and the
 * request fails when nothing arrives for `timing.idleMs`. A server that ignored the request to stream and answered
 * with one JSON body returns that body (`whole`) instead.
 */
export async function stream(provider: string, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, onEvent: (data: unknown) => void): Promise<{ whole?: unknown }> {
  return send(provider, url, headers, body, signal, true, async (res, alive) => {
    if (!/text\/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) {
      // Read in pieces so the idle timer sees a slow body arrive.
      let text = '';
      const decoder = new TextDecoder();
      if (res.body)
        for await (const chunk of res.body) {
          alive();
          text += decoder.decode(chunk as Uint8Array, { stream: true });
        }
      return { whole: parseJson(provider, text + decoder.decode()) };
    }
    const decoder = new TextDecoder();
    let buf = '';
    const flush = (block: string) => {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data || data === '[DONE]') return;
      onEvent(parseJson(provider, data));
    };
    for await (const chunk of res.body) {
      alive();
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        flush(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) flush(buf);
    return {};
  }) as Promise<{ whole?: unknown }>;
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
