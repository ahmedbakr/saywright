/**
 * Changes and reports through a subscription the person already pays for:
 * the studio runs the official app on this computer (Claude Code, Codex or
 * Gemini CLI), signed in the app's own way. Nothing is read from the apps'
 * sign-in files; for Claude Code, API-key variables are kept out of its
 * environment so the plan is used, not a key.
 *
 * The app reads the code with its own read-only tools and proposes the change
 * through the studio's MCP endpoint (a token for this one run, offering only
 * propose_change), so the person still sees a preview to keep or undo. Its
 * built-in tools that write or run commands are switched off.
 *
 * Token-safe: the studio's own short instructions replace the app's default
 * system prompt where the app allows it (Claude Code), the run has no session
 * history, and it stops after a time limit.
 */
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';
import type { AiEffort, ProviderKind, Usage } from '../../shared/ai.ts';
import type { McpServer, McpTool } from '../mcp.ts';
import { spawnProgram } from '../program.ts';
import type { Project } from '../project.ts';
import { ProposeChange } from './agent.ts';
import { systemPrompt, userMessage } from './context.ts';
import { jsonSchemaOf } from './llm/types.ts';
import { applyEditSpecs } from './tools.ts';
import { AgentError, type AgentContext, type AgentInput, type AgentOutput, type AgentProvider } from './types.ts';

export type CliKind = Extract<ProviderKind, 'claude-code' | 'codex' | 'gemini-cli'>;

const LIMIT_MS = 10 * 60_000;

/** Gemini CLI appends -p to what it reads on stdin: the task goes on stdin (no length limit), this note on the command line. */
const GEMINI_P = 'Follow the instructions above.';

export interface CliUsage {
  model: string;
  usage: Usage;
  /** What the app reports the run would have cost through the API. */
  usd?: number;
}

export interface CliDeps {
  kind: CliKind;
  bin: string;
  model: string;
  effort: AiEffort;
  mcp: McpServer;
  /** The studio's address, for the MCP endpoint. */
  origin: () => string;
  gate?: () => void;
  used?: (u: CliUsage, ms: number) => void;
}

const NAME: Record<CliKind, string> = { 'claude-code': 'Claude', codex: 'Codex', 'gemini-cli': 'Gemini' };

const CLI_RULES = `
How you work here
- You are running inside Saywright on the person's computer, in their app's folder. Read and search the code with your read-only tools; never write files and never run commands that change anything.
- To make a change, call the saywright propose_change tool once with every edit. Each old_string must be copied exactly from the current file and match exactly once. If it reports a problem, correct the edit and call it again. When it accepts the change, reply with one short sentence and stop.
- If the person asked a question, answer it. Don't propose a change unless they asked for one.
- Every plain-text answer, whether to a question, to a request that is already done or needs nothing, or to one you won't do, is at most four short sentences in one paragraph: no lists, headings or bold. Cite files as path:line.`;

/** The environment for a run: telemetry and colors off; for Claude Code, no API key, so the person's plan is used. */
function childEnv(kind: CliKind, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', ...extra };
  if (kind === 'claude-code') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDECODE;
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_AUTOUPDATER = '1';
    // A person is waiting: a few retries ride out a blip; past that, say what is wrong.
    env.CLAUDE_CODE_MAX_RETRIES ??= '3';
  }
  if (kind === 'codex') delete env.OPENAI_API_KEY;
  if (kind === 'gemini-cli') {
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
  }
  return env;
}

interface RunResult {
  text: string;
  usage: CliUsage[];
  failure: string | null;
}

/** Run the app once, feeding `prompt` on stdin and reading its JSON lines. */
function runApp(deps: CliDeps, args: string[], prompt: string, cwd: string, env: NodeJS.ProcessEnv, ctx: Pick<AgentContext, 'progress' | 'signal'>, onLine: (ev: Record<string, unknown>, out: RunResult) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProgram(deps.bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (err) {
      return reject(new AgentError(`Couldn’t start ${NAME[deps.kind]}: ${err instanceof Error ? err.message : String(err)}`, 'other'));
    }
    const out: RunResult = { text: '', usage: [], failure: null };
    let stderr = '';
    let settled = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000).unref();
    };
    const timer = setTimeout(() => {
      out.failure = `${NAME[deps.kind]} took longer than ${LIMIT_MS / 60_000} minutes.`;
      kill();
    }, LIMIT_MS);
    const onAbort = () => kill();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      const t = line.trim();
      if (!t.startsWith('{')) return;
      try {
        onLine(JSON.parse(t) as Record<string, unknown>, out);
      } catch {
        /* not a JSON line */
      }
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AgentError(`Couldn’t start ${NAME[deps.kind]}: ${err.message}`, 'other'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (ctx.signal?.aborted) return reject(new AgentError('Stopped.', 'aborted'));
      if (code !== 0 && !out.failure && !out.text) out.failure = explain(deps.kind, stderr) ?? `${NAME[deps.kind]} stopped (exit code ${code}).`;
      resolve(out);
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(prompt);
  });
}

/** What went wrong, from the app's own words, as something the person can act on. */
export function explain(kind: CliKind, stderr: string): string | null {
  const s = stderr.toLowerCase();
  if (/not (logged|signed) in|please (log|sign) in|login required|authenticat|oauth|credentials/.test(s)) {
    return kind === 'claude-code'
      ? 'Claude Code isn’t signed in. Run “claude” once in a terminal and sign in with your Claude account.'
      : kind === 'codex'
        ? 'Codex isn’t signed in. Run “codex login” in a terminal.'
        : 'Gemini CLI isn’t signed in. Run “gemini” once in a terminal and sign in with Google.';
  }
  if (/usage limit|rate limit|quota|too many requests|limit reached|resets? (at|in)/.test(s)) return `Your ${NAME[kind]} plan’s usage limit is reached for now. It resets on the plan’s schedule; another connection can take over in Settings → AI.`;
  if (/econnrefused|enotfound|etimedout|connection (refused|error|reset)|network error|fetch failed|unable to connect/.test(s)) {
    const vendor = kind === 'claude-code' ? 'Anthropic' : kind === 'codex' ? 'OpenAI' : 'Google';
    return `${NAME[kind]} couldn’t reach ${vendor}. Check the internet connection (or a proxy) and try again.`;
  }
  const last = stderr.trim().split('\n').filter(Boolean).pop();
  return last ? `${NAME[kind]}: ${last.slice(0, 300)}` : null;
}

function relPath(p: unknown, root: string): string {
  if (typeof p !== 'string') return '';
  const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
  return rel.startsWith('..') ? path.basename(p) : rel;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One change or answer, through a subscription app. */
export class CliAgent implements AgentProvider {
  readonly source = 'ai' as const;
  readonly model: string;

  constructor(private deps: CliDeps) {
    this.model = deps.model;
  }

  async run(input: AgentInput, ctx: AgentContext): Promise<AgentOutput> {
    const { deps } = this;
    const { project } = ctx;
    deps.gate?.();
    let proposal: AgentOutput | null = null;
    const tool: McpTool = {
      name: 'propose_change',
      description: 'Propose the code change that fulfils the request. Call it once, with every edit. Each old_string must match the current file exactly once. The person sees the change live and keeps or undoes it.',
      inputSchema: jsonSchemaOf(ProposeChange),
      run: (args) => {
        const parsed = ProposeChange.safeParse(args);
        if (!parsed.success) throw new Error(`The change didn't match the expected shape: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        ctx.progress('Checking', 'the change');
        const edits = applyEditSpecs(project, parsed.data.edits);
        proposal = { kind: 'change', title: parsed.data.title.slice(0, 80), summary: parsed.data.summary, edits };
        return 'The change is live for the person to review. Reply with one short sentence and stop.';
      },
    };
    const run = deps.mcp.openRun([tool]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-run-'));
    const started = Date.now();
    try {
      ctx.progress('Thinking', `with ${NAME[deps.kind]}`);
      const system = systemPrompt(project) + '\n' + CLI_RULES;
      const ask = userMessage(input, project);
      const { args, prompt, env } = this.command(system, ask, run.token, tmp, project);
      const out = await runApp(deps, args, prompt, project.root, env, ctx, (ev, o) => onEvent(deps.kind, deps.model, ev, o, ctx.progress, project.root));
      for (const u of out.usage) deps.used?.(u, Date.now() - started);
      if (proposal) return proposal;
      if (out.failure) throw new AgentError(out.failure, /signed in|sign in/.test(out.failure) ? 'auth' : /limit/.test(out.failure) ? 'rate' : 'other');
      if (out.text) return { kind: 'answer', text: out.text };
      throw new AgentError(`${NAME[deps.kind]} finished without a change or an answer. Try rephrasing.`, 'other');
    } finally {
      run.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private command(system: string, ask: string, token: string, tmp: string, project: Project): { args: string[]; prompt: string; env: NodeJS.ProcessEnv } {
    const { deps } = this;
    const url = `${deps.origin()}/api/mcp`;
    if (deps.kind === 'claude-code') {
      const sys = path.join(tmp, 'system.md');
      fs.writeFileSync(sys, system);
      const args = [
        '-p',
        '--output-format', 'stream-json', '--verbose',
        '--system-prompt-file', sys,
        '--tools', 'Read,Grep,Glob',
        '--allowedTools', 'Read,Grep,Glob,mcp__saywright__propose_change',
        '--permission-mode', 'dontAsk',
        '--permission-prompts', 'none',
        '--strict-mcp-config',
        '--mcp-config', JSON.stringify({ mcpServers: { saywright: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
        '--setting-sources', 'user',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--effort', deps.effort,
        ...(deps.model && deps.model !== 'default' ? ['--model', deps.model] : []),
      ];
      return { args, prompt: ask, env: childEnv('claude-code', {}) };
    }
    if (deps.kind === 'codex') {
      const args = [
        'exec', '--json', '--skip-git-repo-check', '--ephemeral',
        '-C', project.root,
        '-c', 'sandbox_mode="read-only"',
        '-c', 'approval_policy="never"',
        '-c', `model_reasoning_effort="${deps.effort}"`,
        '-c', `mcp_servers.saywright.url="${url}"`,
        '-c', 'mcp_servers.saywright.bearer_token_env_var="SAYWRIGHT_MCP_TOKEN"',
        '-c', 'mcp_servers.saywright.default_tools_approval_mode="approve"',
        ...(deps.model && deps.model !== 'default' ? ['-m', deps.model] : []),
        '-',
      ];
      return { args, prompt: `${system}\n\n---\n\n${ask}`, env: childEnv('codex', { SAYWRIGHT_MCP_TOKEN: token }) };
    }
    // Gemini CLI reads MCP servers from settings: a settings file for this run only.
    const settings = path.join(tmp, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: { saywright: { httpUrl: url, headers: { Authorization: `Bearer ${token}` }, trust: true } } }));
    const args = ['-p', GEMINI_P, '-o', 'stream-json', '--allowed-mcp-server-names', 'saywright', ...(deps.model && deps.model !== 'default' ? ['-m', deps.model] : [])];
    return { args, prompt: `${system}\n\n---\n\n${ask}`, env: childEnv('gemini-cli', { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings }) };
  }
}

/** One line of an app's JSON output: progress for the person, the answer, what it used, what went wrong. */
function onEvent(kind: CliKind, model: string, ev: Record<string, unknown>, out: RunResult, progress: AgentContext['progress'], root: string): void {
  if (kind === 'claude-code') {
    if (ev.type === 'system' && ev.subtype === 'init') {
      const servers = (ev.mcp_servers ?? []) as { name: string; status: string }[];
      const ours = servers.find((s) => s.name === 'saywright');
      if (ours && ours.status !== 'connected') out.failure = `Claude Code couldn’t reach the studio (${ours.status}).`;
    } else if (ev.type === 'assistant') {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as { type: string; name?: string; input?: Record<string, unknown> }[];
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        if (b.name === 'Read') progress('Reading', relPath(b.input?.file_path, root));
        else if (b.name === 'Grep') progress('Searching', String(b.input?.pattern ?? ''));
        else if (b.name === 'Glob') progress('Looking', String(b.input?.pattern ?? ''));
      }
    } else if (ev.type === 'result') {
      const text = typeof ev.result === 'string' ? ev.result.trim() : '';
      // A failed run still ends with a result: its text is the error, not an answer.
      if (ev.is_error || /^API Error\b/i.test(text)) out.failure = explain('claude-code', text) ?? (text ? `Claude Code: ${text.slice(0, 300)}` : `Claude Code stopped (${String(ev.subtype)}).`);
      else out.text = text;
      const per = (ev.modelUsage ?? {}) as Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
      const entries = Object.entries(per);
      if (entries.length) {
        for (const [model, u] of entries) out.usage.push({ model, usage: { input: n(u.inputTokens), output: n(u.outputTokens), cacheRead: n(u.cacheReadInputTokens), cacheWrite: n(u.cacheCreationInputTokens) }, usd: u.costUSD });
      } else {
        const u = (ev.usage ?? {}) as Record<string, unknown>;
        out.usage.push({ model: model, usage: { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) }, usd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined });
      }
    }
    return;
  }
  if (kind === 'codex') {
    const item = ev.item as { type?: string; text?: string; command?: string; tool?: string; server?: string } | undefined;
    if (ev.type === 'item.started' && item?.type === 'command_execution') progress('Reading', String(item.command ?? '').slice(0, 60));
    if (ev.type === 'item.completed' && item?.type === 'agent_message' && item.text) out.text = item.text.trim();
    if (ev.type === 'turn.completed') {
      const u = (ev.usage ?? {}) as Record<string, unknown>;
      const cached = n(u.cached_input_tokens);
      out.usage.push({ model: model, usage: { input: Math.max(0, n(u.input_tokens) - cached), output: n(u.output_tokens), cacheRead: cached, cacheWrite: n(u.cache_write_input_tokens), reasoning: n(u.reasoning_output_tokens) } });
    }
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      const msg = String((ev.error as { message?: string } | undefined)?.message ?? ev.message ?? 'Codex stopped.');
      out.failure = explain('codex', msg) ?? msg;
    }
    return;
  }
  // Gemini CLI
  if (ev.type === 'tool_use') {
    const name = String(ev.tool_name ?? '');
    const params = (ev.parameters ?? {}) as Record<string, unknown>;
    if (/read/.test(name)) progress('Reading', relPath(params.file_path ?? params.absolute_path ?? params.path, root));
    else if (/grep|search/.test(name)) progress('Searching', String(params.pattern ?? ''));
  } else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
    out.text = ev.delta ? out.text + ev.content : ev.content;
  } else if (ev.type === 'result') {
    const stats = (ev.stats ?? {}) as { models?: Record<string, { input_tokens?: number; output_tokens?: number; cached?: number }>; input_tokens?: number; output_tokens?: number; cached?: number };
    const models = Object.entries(stats.models ?? {});
    const list = models.length ? models : [[model, stats] as const];
    for (const [model, s] of list) {
      const cached = n(s.cached);
      out.usage.push({ model, usage: { input: Math.max(0, n(s.input_tokens) - cached), output: n(s.output_tokens), cacheRead: cached, cacheWrite: 0 } });
    }
    if (ev.status === 'error') {
      const msg = String((ev.error as { message?: string } | undefined)?.message ?? 'Gemini CLI stopped.');
      out.failure = explain('gemini-cli', msg) ?? msg;
    }
    out.text = out.text.trim();
  } else if (ev.type === 'error' && ev.severity === 'error') {
    out.failure = explain('gemini-cli', String(ev.message ?? '')) ?? String(ev.message ?? 'Gemini CLI stopped.');
  }
}

/** Structured output (a report, a review) through a subscription app: JSON matching `schema`. */
export async function cliJson<T>(deps: CliDeps, opts: { system: string; prompt: string; schema: z.ZodType<T>; images?: { name: string; data: string }[]; cwd: string; signal?: AbortSignal; progress?: (step: string, detail?: string) => void }): Promise<T> {
  deps.gate?.();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-json-'));
  const started = Date.now();
  try {
    const shots = (opts.images ?? []).map((img) => {
      const file = path.join(tmp, `${img.name.replace(/[^\w.-]/g, '_')}.jpg`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      return { name: img.name, file };
    });
    const schemaJson = JSON.stringify(jsonSchemaOf(opts.schema));
    const shotNote = shots.length ? `\n\nScreenshots for this task are image files you can open with your read tool:\n${shots.map((s) => `- ${s.name}: ${s.file}`).join('\n')}` : '';
    let args: string[];
    let prompt = `${opts.prompt}${shotNote}`;
    let env: NodeJS.ProcessEnv;
    if (deps.kind === 'claude-code') {
      const sys = path.join(tmp, 'system.md');
      fs.writeFileSync(sys, opts.system);
      args = ['-p', '--output-format', 'stream-json', '--verbose', '--system-prompt-file', sys, '--json-schema', schemaJson, '--tools', shots.length ? 'Read' : '', '--allowedTools', 'Read', '--add-dir', tmp, '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--setting-sources', 'user', '--no-session-persistence', '--disable-slash-commands', '--effort', deps.effort, ...(deps.model !== 'default' ? ['--model', deps.model] : [])];
      env = childEnv('claude-code', {});
    } else if (deps.kind === 'codex') {
      const schemaFile = path.join(tmp, 'schema.json');
      fs.writeFileSync(schemaFile, schemaJson);
      args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', opts.cwd, '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '--output-schema', schemaFile, ...shots.flatMap((s) => ['--image', s.file]), ...(deps.model !== 'default' ? ['-m', deps.model] : []), '-'];
      prompt = `${opts.system}\n\n---\n\n${opts.prompt}`;
      env = childEnv('codex', {});
    } else {
      args = ['-p', GEMINI_P, '-o', 'stream-json', ...(deps.model !== 'default' ? ['-m', deps.model] : [])];
      prompt = `${opts.system}\n\n---\n\n${opts.prompt}${shots.length ? `\n\nScreenshots: ${shots.map((s) => `@${s.file}`).join(' ')}` : ''}\n\nAnswer with one JSON object only (no prose, no code fence), matching this JSON Schema:\n${schemaJson}`;
      env = childEnv('gemini-cli', {});
    }
    let structured: unknown = undefined;
    const progress = opts.progress ?? (() => undefined);
    const out = await runApp(deps, args, prompt, deps.kind === 'claude-code' ? tmp : opts.cwd, env, { progress, signal: opts.signal }, (ev, o) => {
      if (deps.kind === 'claude-code' && ev.type === 'result' && ev.structured_output !== undefined) structured = ev.structured_output;
      onEvent(deps.kind, deps.model, ev, o, progress, opts.cwd);
    });
    for (const u of out.usage) deps.used?.(u, Date.now() - started);
    if (structured === undefined) {
      if (out.failure) throw new AgentError(out.failure, 'other');
      const text = out.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      try {
        structured = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
      } catch {
        throw new AgentError(`${NAME[deps.kind]} didn’t answer in the expected format.`, 'other');
      }
    }
    const parsed = opts.schema.safeParse(structured);
    if (!parsed.success) throw new AgentError(`${NAME[deps.kind]}’s answer didn’t match the expected format: ${parsed.error.issues[0]?.message ?? ''}`, 'other');
    return parsed.data;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
