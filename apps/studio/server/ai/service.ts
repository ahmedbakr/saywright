/**
 * Everything AI in one place: which connection and model does each job, the
 * budget check before every call, and the usage ledger after it. The rest of
 * the studio asks for "an agent for code" or "JSON for a report" and doesn't
 * care whether a key, a plan or a local model answers.
 */
import path from 'node:path';
import type { z } from 'zod';
import { AI_TASKS, type AiEffort, type AiState, type AiTask, type ConnectionView, type Price, type Usage } from '../../shared/ai.ts';
import { costOf, dearestKnown, modelInfo, sameModel, savedBy } from '../../shared/models.ts';
import type { McpServer } from '../mcp.ts';
import { ModelAgent } from './agent.ts';
import { CliAgent, cliJson, type CliDeps, type CliKind, type CliUsage } from './cli.ts';
import { Connections, kindLabel } from './connections.ts';
import { inputTokens, textTokens } from './llm/tokens.ts';
import { amount, dropNulls, jsonSchemaOf, noFallback, type Admit, type ChatModel, type ChatResult, type Msg, type Part, type Ticket } from './llm/types.ts';
import { AgentError, type AgentProvider } from './types.ts';
import { UsageLedger } from './usage.ts';

export interface JsonRequest<T> {
  task: AiTask;
  feature: string;
  system: string;
  parts: Part[];
  schema: z.ZodType<T>;
  name: string;
  maxTokens: number;
  effort?: AiEffort;
  signal?: AbortSignal;
  /** Where a subscription app runs (the app's folder). */
  cwd?: string;
  /** The system prompt is sent again soon (Autopilot's every turn): worth caching. Left out for one-off requests. */
  cache?: 'system';
}

interface AiDeps {
  dataDir: string;
  envDir: string;
  mcp: McpServer;
  origin: () => string;
  /** The open app, for the usage breakdown. */
  app: () => { id: string; name: string } | null;
  appNames: () => Record<string, string>;
  /** Used by the automated tests: a stand-in that never calls a provider. */
  fake?: () => AgentProvider;
}

const CLI_KINDS = new Set(['claude-code', 'codex', 'gemini-cli']);
const tokensIn = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;
/** About how many tokens an answer took, for a provider that didn't say: its text and its tool calls. */
const answerTokens = (res: ChatResult) => textTokens(res.text) + res.calls.reduce((n, c) => n + textTokens(JSON.stringify(c.args)) + 10, 0);

/** A listed price that can be used: none when any rate is negative or not a number (OpenRouter writes -1 for "varies"). */
export function usablePrice(p: Price | null | undefined): Price | undefined {
  if (!p) return undefined;
  const ok = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const rates = (r: Partial<Price>) => ok(r.input) && ok(r.output) && ok(r.cacheRead) && ok(r.cacheWrite);
  return typeof p.input === 'number' && typeof p.output === 'number' && rates(p) && (!p.long || rates(p.long)) ? p : undefined;
}
const CARRY_ON = 'Raise the limit or reset the count in Settings → Usage and budget to carry on.';

/**
 * The name a call is written down under: the model asked for, when the one that answered is it under its provider's
 * name for it (a dated snapshot, a maker's prefix), so one model's use isn't split across names; else the one that
 * answered (a fallback for a declined request, a plan's own model).
 */
const answeredAs = (asked: string, answered?: string): string => (answered && !sameModel(asked, answered) ? answered : asked);

export class AiService {
  readonly connections: Connections;
  readonly usage: UsageLedger;
  /** A recorded call, announced to the studio (usage pill, budget warnings). */
  onUsage: (() => void) | null = null;

  constructor(private deps: AiDeps) {
    this.connections = new Connections(path.join(deps.dataDir, 'ai.json'), deps.envDir);
    this.usage = new UsageLedger(path.join(deps.dataDir, 'usage'));
  }

  get effort(): AiEffort {
    return this.connections.config.effort;
  }

  /**
   * Whether a request for `task` may start, before its size is known (Autopilot's first step, a subscription app's
   * run): throws when the budget says stop. A request paid by a plan or run on this computer isn't held to the
   * dollar limits, only to the token limit.
   */
  gate(task: AiTask = 'code'): void {
    const c = this.connections.route(task)?.connection;
    this.allowed(!c || c.auth === 'key');
  }

  private allowed(billed: boolean): void {
    const { ok, status } = this.usage.allow(Date.now(), billed);
    if (!ok) throw new AgentError(`${status.message ?? 'The AI budget is used up.'} ${CARRY_ON}`, 'budget');
  }

  /** A model's price; a plan's own default model isn't named, so it is priced as the app's most capable one (an estimate, for comparison only). */
  private priceOf(c: ConnectionView, model: string): Price | undefined {
    const priced = model === 'default' ? (c.models.find((m) => m.id !== 'default' && m.price)?.id ?? model) : model;
    // A dated name ("claude-opus-5-5-20261015", "gpt-6.1-sol-2026-09-30") is priced as the model it names.
    const undated = priced.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
    return usablePrice((c.models.find((m) => m.id === priced || m.id === undated) ?? modelInfo(c.kind, priced) ?? modelInfo(c.kind, undated))?.price);
  }

  /**
   * How many more tokens than estimated a model's requests have been seen to send (its tokenizer counts more than the
   * estimate does): later estimates are made that much bigger, so a budget isn't short twice for the same reason. It
   * rises at once and comes back down by half the gap with each call that sends what was estimated, never below 1 or
   * above 4, so one oversized call doesn't inflate every later one; resetting the counts forgets it.
   */
  private inputScale = new Map<string, number>();

  /** Start counting again (Settings → Usage and budget): the history of what models sent goes too. */
  resetUsage(scope: 'today' | 'month' | 'all'): void {
    this.usage.reset(scope);
    this.inputScale.clear();
  }

  /**
   * Each call's place in the budget, for calls to `model`: the most it can cost is held before it is sent (its room
   * to answer cut to what the budget has left, or the call refused), and what it used is written down after.
   */
  private admit(c: ConnectionView, model: string, feature: string): Admit {
    // A model with no known price is held at its provider's dearest known rates: a limit can't be passed with it.
    const price = this.priceOf(c, model) ?? (c.auth === 'key' ? this.unknownPrice(c) : undefined);
    const billed = c.auth === 'key';
    const key = `${c.id}:${model}`;
    return (call) => {
      const input = Math.ceil(call.input * (this.inputScale.get(key) ?? 1));
      const held = this.usage.hold({ ...call, input, price, billed });
      if ('refused' in held) throw new AgentError(`${held.refused} ${CARRY_ON}`, 'budget');
      let settled = false;
      const estimate = (output: number): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0 });
      return {
        maxTokens: held.maxTokens,
        // A second attempt on another model (a declined request's fallback) can't be set aside: not under a hard limit.
        fallback: !this.usage.bounded(billed),
        settle: (res, ms = 0, err) => {
          if (settled) return;
          settled = true;
          if (res) {
            // Every attempt, each at the price of the model that ran it (else the one that answered, else the one asked).
            const attempts = res.attempts?.length ? res.attempts : [{ model: res.model || model, usage: res.usage }];
            // A provider that sent no usage (some gateways and local servers) is counted at the estimate, never as free.
            const missing = attempts.length === 1 && tokensIn(res.usage) === 0;
            if (missing) this.record(c, answeredAs(model, res.model), estimate(answerTokens(res)), feature, ms, res.usd, model, true);
            else attempts.forEach((a, i) => this.record(c, answeredAs(model, a.model), a.usage, feature, i ? 0 : ms, attempts.length === 1 ? res.usd : undefined, model));
            const sent = attempts[0].usage.input + attempts[0].usage.cacheRead + attempts[0].usage.cacheWrite;
            if (call.input > 0 && !missing) {
              // Up at once (the next call must not be short again), down by half the gap each call.
              const seen = Math.min(4, Math.max(1, sent / call.input));
              this.inputScale.set(key, Math.max(seen, ((this.inputScale.get(key) ?? 1) + seen) / 2));
            }
          } else if (err instanceof AgentError && (err.partial || err.sent)) {
            // Stopped, gone quiet or cut off after it was sent: what the provider said it used, else the estimate.
            this.record(c, model, err.partial && tokensIn(err.partial) > 0 ? err.partial : estimate(0), feature, ms, undefined, model, !(err.partial && tokensIn(err.partial) > 0));
          }
          this.usage.release(held);
        },
      };
    };
  }

  /** One call, or one attempt of it, written down: priced at the model that ran it (else `asked`'s, the model asked). */
  /** The rates a call to a model with no known price is counted at: its provider's dearest known ones. */
  private unknownPrice(c: ConnectionView): Price {
    return dearestKnown(c.kind, c.models.map((m) => usablePrice(m.price)));
  }

  private record(c: ConnectionView, model: string, u: Usage, feature: string, ms: number, reportedUsd?: number, asked?: string, estimated = false): void {
    let price = this.priceOf(c, model) ?? (asked ? this.priceOf(c, asked) : undefined);
    // Paid in dollars at a price nobody listed (and the provider didn't say): counted at the dearest known rates, as
    // an estimate, rather than as free.
    if (!price && c.auth === 'key' && amount(reportedUsd) === undefined) {
      price = this.unknownPrice(c);
      estimated = true;
    }
    const computed = costOf(price, u);
    const usd = amount(reportedUsd) ?? (computed != null && Number.isFinite(computed) ? Math.max(0, computed) : computed);
    const app = this.deps.app();
    const saved = savedBy(price, u);
    this.usage.record({
      t: Date.now(),
      app: app?.id ?? null,
      appName: app?.name,
      feature,
      connection: c.id,
      kind: c.kind,
      model,
      plan: c.auth === 'subscription',
      ...u,
      usd: c.auth === 'local' ? 0 : usd,
      saved: saved && saved > 0 ? saved : 0,
      ms,
      ...(estimated ? { estimate: true } : {}),
    });
    this.onUsage?.();
  }

  private cliDeps(c: ConnectionView, model: string, feature: string): CliDeps {
    const bin = this.connections.binary(c.id);
    if (!bin) throw new AgentError(`${c.label} isn’t installed on this computer.`, 'no-key');
    return {
      kind: c.kind as CliKind,
      bin,
      model,
      effort: this.effort,
      mcp: this.deps.mcp,
      origin: this.deps.origin,
      gate: () => this.allowed(c.auth === 'key'),
      used: (u: CliUsage, ms) => this.record(c, answeredAs(model, u.model), u.usage, feature, ms, u.usd, model),
    };
  }

  /** The agent for changes and questions, or null when nothing is connected. */
  agent(feature: 'edit' | 'answer' | 'fix' = 'edit'): AgentProvider | null {
    if (this.deps.fake) return this.deps.fake();
    const r = this.connections.route('code');
    if (!r) return null;
    if (CLI_KINDS.has(r.connection.kind)) return new CliAgent(this.cliDeps(r.connection, r.model, feature));
    const chat = this.connections.chatModel(r.connection.id, r.model);
    if (!chat) return null;
    const c = r.connection;
    return new ModelAgent(chat, this.effort, { admit: this.admit(c, r.model, feature) }, kindLabel(c.kind) === 'the model' ? c.label : kindLabel(c.kind));
  }

  /** Which connection and model would do a task, for the studio to show. */
  who(task: AiTask): { connection: string; label: string; model: string; plan: boolean } | null {
    const r = this.connections.route(task);
    if (!r) return null;
    const m = r.connection.models.find((x) => x.id === r.model);
    return { connection: r.connection.id, label: r.connection.label, model: m?.label ?? r.model, plan: r.connection.auth === 'subscription' };
  }

  /** JSON matching a schema, from whatever does `task`: an API model (checked, with one repair) or a subscription app. */
  async json<T>(req: JsonRequest<T>): Promise<{ value: T; model: string }> {
    const r = this.connections.route(req.task);
    if (!r) throw new AgentError('No AI is connected. Add one in Settings → AI.', 'no-key');
    const c = r.connection;
    if (CLI_KINDS.has(c.kind)) {
      const text = req.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n\n');
      const images = req.parts.flatMap((p, i) => (p.type === 'image' ? [{ name: `screenshot-${i}`, data: p.data }] : []));
      const value = await cliJson(this.cliDeps(c, r.model, req.feature), { system: req.system, prompt: text, schema: req.schema, images, cwd: req.cwd ?? process.cwd(), signal: req.signal });
      return { value, model: r.model === 'default' ? c.label : r.model };
    }
    const chat = this.connections.chatModel(c.id, r.model);
    if (!chat) throw new AgentError(`${c.label} can’t be used right now.`, 'other');
    const parts = chat.vision ? req.parts : req.parts.filter((p) => p.type === 'text');
    // A report can be 100,000 tokens: one that could go past a stopping budget isn't sent.
    return jsonFrom(chat, { ...req, parts }, this.admit(c, r.model, req.feature));
  }

  /** A tiny real call, to check a connection works (a few tokens). */
  async test(connectionId: string): Promise<{ ok: boolean; message: string }> {
    await this.connections.refresh(true);
    const c = this.connections.get(connectionId);
    if (!c) return { ok: false, message: 'Unknown connection.' };
    if (c.status !== 'ready') return { ok: false, message: c.detail ?? 'Not ready.' };
    if (CLI_KINDS.has(c.kind)) return { ok: true, message: c.detail ?? 'Ready.' };
    const model = c.models.find((m) => m.tier === 'fast')?.id ?? c.models[0]?.id;
    if (!model) return { ok: false, message: 'It lists no models.' };
    const chat = this.connections.chatModel(c.id, model);
    if (!chat) return { ok: false, message: 'Not available.' };
    const system = 'Reply with the single word OK.';
    const messages: Msg[] = [{ role: 'user', parts: [{ type: 'text', text: 'Connection check.' }] }];
    let ticket: Ticket;
    try {
      // A check is a paid call like any other: held to the budget, and written down.
      ticket = this.admit(c, model, 'test')({ input: inputTokens({ system, messages }), maxTokens: 16, minTokens: 16 });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    const started = Date.now();
    try {
      // A check needs no second model: one that declines it says the connection works.
      const res = await chat.chat({ system, messages, maxTokens: ticket.maxTokens, fallback: false });
      ticket.settle(res, Date.now() - started);
      return { ok: true, message: `Connected. ${c.models.find((m) => m.id === model)?.label ?? model} answered.` };
    } catch (err) {
      ticket.settle(null, Date.now() - started, err);
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async state(refresh = false): Promise<Omit<AiState, 'mcp'>> {
    await this.connections.refresh(refresh);
    const connections = this.connections.list();
    const routes = {} as AiState['routes'];
    for (const t of AI_TASKS) {
      const r = this.connections.route(t.id);
      routes[t.id] = r ? { connection: r.connection.id, model: r.model } : null;
    }
    return { connections, routes, chosen: { ...this.connections.config.routes }, effort: this.effort, ready: !!this.deps.fake || !!routes.code, usage: this.usage.summary(Date.now(), this.deps.appNames()) };
  }
}

/**
 * Ask an API model for JSON, check it against the schema, and give it one chance to repair a bad answer. Each call
 * has its place in the budget first, with all the room it asks for: an answer cut short would be no JSON at all.
 */
export async function jsonFrom<T>(chat: ChatModel, req: Pick<JsonRequest<T>, 'system' | 'parts' | 'schema' | 'name' | 'maxTokens' | 'effort' | 'signal' | 'cache'>, admit: Admit): Promise<{ value: T; model: string }> {
  const messages: Msg[] = [{ role: 'user', parts: req.parts }];
  const schema = jsonSchemaOf(req.schema);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ticket = admit({ input: inputTokens({ system: req.system, messages, schema }), maxTokens: req.maxTokens, minTokens: req.maxTokens });
    const started = Date.now();
    let res: ChatResult;
    try {
      res = await chat.chat({ system: req.system, messages, json: { name: req.name, schema: req.schema }, maxTokens: ticket.maxTokens, effort: req.effort, signal: req.signal, cache: req.cache, fallback: ticket.fallback });
    } catch (err) {
      ticket.settle(null, Date.now() - started, err);
      throw err;
    }
    ticket.settle(res, Date.now() - started);
    if (res.stop === 'refusal') throw new AgentError(`The model declined to write this.${noFallback(chat, ticket)}`, 'refused');
    if (res.stop === 'length') throw new AgentError('The answer was too long for the model’s limit.', 'other');
    let problem: string;
    try {
      const raw = JSON.parse(stripFence(res.text));
      const parsed = req.schema.safeParse(dropNulls(raw));
      if (parsed.success) return { value: parsed.data, model: res.model };
      problem = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch (err) {
      problem = `not valid JSON (${err instanceof Error ? err.message : String(err)})`;
    }
    messages.push({ role: 'assistant', text: res.text, calls: [], raw: res.raw }, { role: 'user', parts: [{ type: 'text', text: `That answer doesn't match the required format: ${problem}. Answer again with the complete JSON only.` }] });
  }
  throw new AgentError('The model’s answer didn’t match the expected format.', 'other');
}

const stripFence = (t: string) => {
  const s = t.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
};
