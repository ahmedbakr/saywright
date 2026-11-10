/**
 * The coding agent, for any model with tools: it reads the code it needs
 * (read_file, search_code, list_files) and proposes one change
 * (propose_change), which the studio shows as a live preview to keep or undo.
 * An edit that doesn't apply goes back to the model with the reason, so it can
 * correct itself. A turn cut off at the length limit has none of its calls
 * run, and the changes proposed in one turn land together or not at all: what
 * the person previews is always the whole of what its title says.
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

/**
 * What the model is told, once, when a turn that was calling tools stopped at the length limit. Nothing of that turn
 * is run or sent back: a call cut in the middle can read as a complete, smaller one.
 */
const CUT_TURN =
  'Your last answer was cut off at the length limit before it was complete. Nothing in it was run. Send it again so that it fits: one propose_change with smaller edits (replace only the lines that change, never a whole file). If everything that was asked cannot fit in one answer, propose the most important part now, with a title that names only that part, and say in the summary what is still to do.';
/** What stands for the cut turn in the conversation when it had no words of its own. */
const CUT_PLACEHOLDER = '(My answer was cut off at the length limit.)';

type ToolResult = { id: string; name: string; output: string; error?: boolean };

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
    /** Whether the model was already told that a turn of its was cut off (it is told once). */
    let cut = false;
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
      /** The budget left this turn less room than a turn gets: then that, not the request's size, is why it was cut. */
      const tight = ticket.maxTokens < MAX_ANSWER;
      const room = (who: string) => `what is left of your budget let ${who} answer in only about ${Math.round(ticket.maxTokens / 1000)}K tokens`;
      const outOfRoom = () => new AgentError(`${this.name} ran out of room before finishing: ${room('it')}. Raise the limit in Settings → Usage and budget, or try a smaller request.`, 'budget');
      if (!res.calls.length) {
        // An answer that stops in mid-sentence is shown as what it is.
        if (res.text && res.stop === 'length') return { kind: 'answer', text: `${res.text} … (Cut short: ${tight ? `${room(this.name)}. Raise the limit in Settings → Usage and budget for a full answer.` : 'the answer reached its length limit.'})` };
        if (res.text) return { kind: 'answer', text: res.text };
        if (res.stop === 'length' && tight) throw outOfRoom();
        if (res.stop === 'length') throw new AgentError(`${this.name} ran out of room before finishing. Try a smaller request.`, 'other');
        throw new AgentError(`${this.name} finished without a change or an answer. Try rephrasing.`, 'other');
      }
      if (res.stop === 'length') {
        // A turn cut off while it was calling tools: none of its calls is run. One cut in the middle can read as a
        // whole, smaller change (a provider's parser closes what was left open), and would land under the title of
        // all of it. The model is told once; cut again, the request stops with what the person can do.
        if (cut) throw tight ? outOfRoom() : new AgentError('The change was too long for one answer: ask for it in smaller parts.', 'other');
        cut = true;
        progress('Retrying', 'the answer was cut off');
        // In words only: the unfinished call itself is not sent back (providers refuse arguments that aren't JSON).
        messages.push({ role: 'assistant', text: res.text || CUT_PLACEHOLDER, calls: [] }, { role: 'user', parts: [{ type: 'text', text: CUT_TURN }] });
        continue;
      }
      messages.push({ role: 'assistant', text: res.text, calls: res.calls, raw: res.raw });
      // Every change proposed in this turn, as one: the first alone would leave the others out without a word.
      const proposals = res.calls.filter((c) => c.name === 'propose_change');
      const proposed = proposals.length ? this.propose(proposals, ctx) : null;
      if (proposed?.change) return proposed.change;
      const results: ToolResult[] = [];
      for (const call of res.calls) {
        if (call.name === 'propose_change') {
          results.push({ id: call.id, name: call.name, output: proposed?.errors.get(call.id) ?? 'The change could not be applied.', error: true });
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

  /**
   * The change a turn proposed. Several propose_change calls in one turn are one change, with every edit of each in
   * the order given: all of it applies, or none of it does and each call is answered with why (`errors`, by call id),
   * so nothing the model sent is left out without it being told.
   */
  private propose(calls: ToolCall[], ctx: AgentContext): { change?: AgentOutput; errors: Map<string, string> } {
    const errors = new Map<string, string>();
    /** Why a call wasn't applied, and, when the turn had several, that none of them was. */
    const refused = (why: string) => (calls.length > 1 ? `${why.replace(/\.$/, '')}. None of this turn’s changes was applied: send one propose_change with every edit.` : why);
    const parsed = calls.map((call) => ({ call, shape: ProposeChange.safeParse(call.args) }));
    const good = parsed.flatMap((p) => (p.shape.success ? [p.shape.data] : []));
    if (good.length < calls.length) {
      for (const p of parsed) {
        const why = p.shape.success ? 'Another propose_change in the same turn didn’t match the expected shape' : `The change didn't match the expected shape: ${p.shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        errors.set(p.call.id, refused(why));
      }
      return { errors };
    }
    try {
      const edits = applyEditSpecs(ctx.project, good.flatMap((g) => g.edits));
      const summaries = [...new Set(good.map((g) => g.summary.trim()).filter(Boolean))];
      return { change: { kind: 'change', title: titleOf(good.map((g) => g.title)), summary: good.length === 1 ? good[0].summary : summaries.join(' '), edits }, errors };
    } catch (err) {
      ctx.progress('Retrying', 'adjusting the edit');
      // The reason names the file of the edit that failed: every call of the turn gets it.
      for (const call of calls) errors.set(call.id, refused(err instanceof Error ? err.message : String(err)));
      return { errors };
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

/** A change's title, at most 80 characters: one call's own, or every call's when they fit, else the first and how many more. */
function titleOf(titles: string[]): string {
  const [first, ...rest] = titles.map((t) => t.trim());
  if (!rest.length) return titles[0].slice(0, 80);
  const all = [first, ...rest].join(' · ');
  if (all.length <= 80) return all;
  const more = ` (and ${rest.length} more)`;
  return `${first.slice(0, 80 - more.length)}${more}`;
}

/** A short stable hash (for cache keys that shouldn't carry paths). */
export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
