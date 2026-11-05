/**
 * The coding agent, for any model with tools: it reads the code it needs
 * (read_file, search_code, list_files) and proposes one change
 * (propose_change), which the studio shows as a live preview to keep or undo.
 * An edit that doesn't apply goes back to the model with the reason, so it can
 * correct itself.
 *
 * Token-safe by construction: the system prompt and every earlier step are
 * cached by the providers that cache; tool output is capped; it stops after a
 * fixed number of steps; and the budget is checked before every call.
 */
import { z } from 'zod';
import type { AiEffort } from '../../shared/api.ts';
import { systemPrompt, userMessage } from './context.ts';
import { inputTokens } from './llm/tokens.ts';
import { noFallback, unwatched, type Admit, type ChatModel, type ChatResult, type Msg, type ToolCall, type ToolDef } from './llm/types.ts';
import { applyEditSpecs, listFilesTool, readFileTool, searchCode } from './tools.ts';
import { AgentError, type AgentContext, type AgentInput, type AgentOutput, type AgentProvider } from './types.ts';

const MAX_STEPS = 10;
/** About 8K tokens: plenty for 400 lines of code, never a runaway context. */
const MAX_TOOL_OUTPUT = 32_000;
/** The room a turn may answer in, and the least worth a turn when the budget has less left (a sizeable change). */
const MAX_ANSWER = 16_000;
const MIN_ANSWER = 4_000;

export const ProposeChange = z.object({
  title: z.string().describe('What changed, at most 60 characters, e.g. "Discount covers items only".'),
  summary: z.string().describe('One or two plain sentences: what changed and why.'),
  edits: z
    .array(
      z.object({
        path: z.string().describe('File path relative to the project root.'),
        old_string: z.string().describe('Exact current text to replace, unique in the file. Empty only when creating a new file.'),
        new_string: z.string().describe('Replacement text.'),
      }),
    )
    .min(1),
});

const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a project file with line numbers. Use it when the code you need is not already in the conversation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project root, e.g. src/lib/pricing.ts' },
        start_line: { type: 'integer', description: 'First line to read (1-based).' },
        end_line: { type: 'integer', description: 'Last line to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search project files for text (case-insensitive). Use it to find where a value, component or function is defined or used. If the answer says it searched only some of the files, search a folder to cover the rest.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, regex: { type: 'boolean', description: 'Treat the query as a regular expression.' }, dir: { type: 'string', description: 'Only this folder, relative to the root, e.g. src/components' } },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'List project source files under a folder.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Folder relative to the root, e.g. src/components' } } },
  },
  {
    name: 'propose_change',
    description: 'Propose the code change that fulfils the request. Call it once, with every edit, when you are confident. Each old_string must match the current file exactly once.',
    parameters: z.toJSONSchema(ProposeChange) as Record<string, unknown>,
  },
];

interface AgentHooks {
  /** Before each model call: its place in the budget (every turn's). Throws to stop (the budget is spent). */
  admit?: Admit;
}

const cap = (s: string) => (s.length > MAX_TOOL_OUTPUT ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n… (cut here; ask for a narrower range)` : s);

export class ModelAgent implements AgentProvider {
  readonly source = 'ai' as const;
  readonly model: string;

  constructor(
    private chat: ChatModel,
    private effort: AiEffort,
    private hooks: AgentHooks = {},
    /** Who answers, for messages ("Claude", "GPT-6.1 Sol"…). */
    private name = 'The model',
  ) {
    this.model = chat.model;
  }

  async run(input: AgentInput, ctx: AgentContext): Promise<AgentOutput> {
    const { project, progress, signal } = ctx;
    const system = systemPrompt(project);
    const messages: Msg[] = [{ role: 'user', parts: [{ type: 'text', text: userMessage(input, project) }] }];
    progress('Thinking');
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new AgentError('Stopped.', 'aborted');
      const ticket = this.hooks.admit?.({ input: inputTokens({ system, messages, tools: TOOLS }), maxTokens: MAX_ANSWER, minTokens: MIN_ANSWER }) ?? unwatched(MAX_ANSWER);
      const started = Date.now();
      let res: ChatResult;
      try {
        res = await this.chat.chat({ system, messages, tools: TOOLS, maxTokens: ticket.maxTokens, effort: this.effort, signal, cacheKey: `saywright-${hash(project.root)}`, cache: 'conversation', fallback: ticket.fallback });
      } catch (err) {
        ticket.settle(null);
        throw err;
      }
      ticket.settle(res, Date.now() - started);
      if (res.stop === 'refusal') throw new AgentError(`${this.name} declined this request. Try rephrasing it.${noFallback(this.chat, ticket)}`, 'refused');
      if (!res.calls.length) {
        if (res.text) return { kind: 'answer', text: res.text };
        if (res.stop === 'length' && ticket.maxTokens < MAX_ANSWER) throw new AgentError(`${this.name} ran out of room before finishing: what is left of your budget let it answer in only about ${Math.round(ticket.maxTokens / 1000)}K tokens. Raise the limit in Settings → Usage and budget, or try a smaller request.`, 'budget');
        if (res.stop === 'length') throw new AgentError(`${this.name} ran out of room before finishing. Try a smaller request.`, 'other');
        throw new AgentError(`${this.name} finished without a change or an answer. Try rephrasing.`, 'other');
      }
      messages.push({ role: 'assistant', text: res.text, calls: res.calls, raw: res.raw });
      const results: { id: string; name: string; output: string; error?: boolean }[] = [];
      for (const call of res.calls) {
        if (call.name === 'propose_change') {
          const out = this.propose(call, ctx);
          if (out.change) return out.change;
          results.push({ id: call.id, name: call.name, output: out.error ?? 'The change could not be applied.', error: true });
          continue;
        }
        try {
          results.push({ id: call.id, name: call.name, output: cap(await this.tool(call, ctx)) });
        } catch (err) {
          results.push({ id: call.id, name: call.name, output: err instanceof Error ? err.message : String(err), error: true });
        }
      }
      messages.push({ role: 'tool', results });
    }
    throw new AgentError(`${this.name} took too many steps without finishing. Try a smaller, more specific request.`, 'other');
  }

  private propose(call: ToolCall, ctx: AgentContext): { change?: AgentOutput; error?: string } {
    const parsed = ProposeChange.safeParse(call.args);
    if (!parsed.success) return { error: `The change didn't match the expected shape: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    try {
      const edits = applyEditSpecs(ctx.project, parsed.data.edits);
      return { change: { kind: 'change', title: parsed.data.title.slice(0, 80), summary: parsed.data.summary, edits } };
    } catch (err) {
      ctx.progress('Retrying', 'adjusting the edit');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async tool(call: ToolCall, ctx: AgentContext): Promise<string> {
    const a = call.args;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined);
    switch (call.name) {
      case 'read_file':
        ctx.progress('Reading', str(a.path));
        return readFileTool(ctx.project, str(a.path), int(a.start_line), int(a.end_line));
      case 'search_code': {
        ctx.progress('Searching', str(a.query));
        const out = await searchCode(ctx.project, str(a.query), a.regex === true, str(a.dir));
        // The person sees it too when a search couldn't cover the whole project.
        if (out.note) ctx.progress('Searching', `${str(a.query)}. ${out.note}`);
        return out.text;
      }
      case 'list_files':
        return listFilesTool(ctx.project, str(a.dir));
      default:
        return `There is no tool called ${call.name}. Use read_file, search_code, list_files or propose_change.`;
    }
  }
}

/** A short stable hash (for cache keys that shouldn't carry paths). */
export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
