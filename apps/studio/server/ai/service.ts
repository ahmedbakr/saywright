/**
 * Everything AI in one place: which connection and model does each job, the
 * budget check before every call, and the usage ledger after it. The rest of
 * the studio asks for "an agent for code" or "JSON for a report" and doesn't
 * care whether a key, a plan or a local model answers.
 */
import path from 'node:path';
import type { z } from 'zod';
import { AI_TASKS, type AiEffort, type AiState, type AiTask, type ConnectionView, type Usage } from '../../shared/ai.ts';
import { costOf, modelInfo, savedBy } from '../../shared/models.ts';
import type { McpServer } from '../mcp.ts';
import { ModelAgent } from './agent.ts';
import { CliAgent, cliJson, type CliDeps, type CliKind, type CliUsage } from './cli.ts';
import { Connections, kindLabel } from './connections.ts';
import { dropNulls, type ChatModel, type ChatResult, type Msg, type Part } from './llm/types.ts';
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

  /** Throws when the budget says stop. */
  gate(): void {
    const { ok, status } = this.usage.allow();
    if (!ok) throw new AgentError(`${status.message ?? 'The AI budget is used up.'} Raise the limit or reset the count in Settings → AI to carry on.`, 'budget');
  }

  private record(c: ConnectionView, model: string, u: Usage, feature: string, ms: number, reportedUsd?: number): void {
    // A plan's own default model isn't named: price it as the app's most capable one (an estimate, for comparison only).
    const priced = model === 'default' ? (c.models.find((m) => m.id !== 'default' && m.price)?.id ?? model) : model;
    const info = c.models.find((m) => m.id === priced) ?? modelInfo(c.kind, priced);
    const price = info?.price;
    const usd = reportedUsd ?? costOf(price, u);
    const app = this.deps.app();
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
      saved: savedBy(price, u),
      ms,
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
      gate: () => this.gate(),
      used: (u: CliUsage, ms) => this.record(c, u.model || model, u.usage, feature, ms, u.usd),
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
    return new ModelAgent(chat, this.effort, { gate: () => this.gate(), used: (res: ChatResult, ms) => this.record(c, r.model, res.usage, feature, ms, res.usd) }, kindLabel(c.kind) === 'the model' ? c.label : kindLabel(c.kind));
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
    return jsonFrom(chat, { ...req, parts }, () => this.gate(), (res, ms) => this.record(c, r.model, res.usage, req.feature, ms, res.usd));
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
    try {
      const started = Date.now();
      const res = await chat.chat({ system: 'Reply with the single word OK.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Connection check.' }] }], maxTokens: 16 });
      this.record(c, model, res.usage, 'test', Date.now() - started, res.usd);
      return { ok: true, message: `Connected. ${c.models.find((m) => m.id === model)?.label ?? model} answered.` };
    } catch (err) {
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

/** Ask an API model for JSON, check it against the schema, and give it one chance to repair a bad answer. */
export async function jsonFrom<T>(chat: ChatModel, req: Pick<JsonRequest<T>, 'system' | 'parts' | 'schema' | 'name' | 'maxTokens' | 'effort' | 'signal' | 'cache'>, gate: () => void, used: (r: ChatResult, ms: number) => void): Promise<{ value: T; model: string }> {
  const messages: Msg[] = [{ role: 'user', parts: req.parts }];
  for (let attempt = 0; attempt < 2; attempt++) {
    gate();
    const started = Date.now();
    const res = await chat.chat({ system: req.system, messages, json: { name: req.name, schema: req.schema }, maxTokens: req.maxTokens, effort: req.effort, signal: req.signal, cache: req.cache });
    used(res, Date.now() - started);
    if (res.stop === 'refusal') throw new AgentError('The model declined to write this.', 'refused');
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
