/**
 * The agent's loop around a model that answers as scripted (no provider): a turn cut off at the length limit never
 * has its tool calls run, a cut answer says it was cut, and several changes proposed in one turn land as one change
 * or not at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelAgent } from '../../server/ai/agent';
import type { Admit, ChatModel, ChatRequest, ChatResult, Msg } from '../../server/ai/llm/types';
import { tempShop } from './helpers';

const USAGE = { input: 2000, output: 16_000, cacheRead: 0, cacheWrite: 0 };
const PRICING = { path: 'src/lib/pricing.ts', old_string: 'const discount = round2((subtotal + shipping) * rate);', new_string: 'const discount = round2(subtotal * rate);' };
const MONEY = { path: 'src/lib/money.ts', old_string: 'export function money', new_string: 'export function formatMoney' };

/** A model that gives these answers in order (the last one again after that), and keeps what it was sent. */
function scripted(...replies: Partial<ChatResult>[]): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    kind: 'anthropic',
    model: 'claude-opus-5-5',
    vision: true,
    requests,
    async chat(req): Promise<ChatResult> {
      // The conversation as it was when it was sent (the loop adds to the same list afterwards).
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as Msg[] });
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      return { text: '', calls: [], stop: reply.calls?.length ? 'tools' : 'end', usage: USAGE, model: this.model, raw: undefined, ...reply };
    },
  };
}

const propose = (id: string, title: string, edits: unknown[]) => ({ id, name: 'propose_change', args: { title, summary: `${title}.`, edits } });
const run = (chat: ChatModel, admit?: Admit) => {
  const project = tempShop();
  const steps: string[] = [];
  const agent = new ModelAgent(chat, 'medium', admit ? { admit } : {}, 'Claude');
  const out = agent.run({ text: 'the discount should not include shipping', refs: [], mode: 'edit' }, { project, progress: (step, detail) => void steps.push(`${step} ${detail ?? ''}`.trim()) });
  return { project, steps, out };
};
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');
/** Everything a request carried back to the model, as text. */
const sentBack = (req: ChatRequest) => JSON.stringify(req.messages.slice(1));

describe('a turn cut off at the length limit', () => {
  it('is never run: a change cut inside its second edit stops after one more try, with what to do', async () => {
    // What a provider's tolerant parser leaves of a call cut in mid-string: the first edit whole, the second without its new text.
    const cut = { calls: [propose('p1', 'Two files', [PRICING, { path: MONEY.path, old_string: MONEY.old_string }])], stop: 'length' as const };
    const chat = scripted(cut);
    const { project, out } = run(chat);
    await expect(out).rejects.toMatchObject({ code: 'other', message: 'The change was too long for one answer: ask for it in smaller parts.' });
    // Told once, then stopped: not ten paid rounds.
    expect(chat.requests).toHaveLength(2);
    expect(sentBack(chat.requests[1])).toMatch(/cut off at the length limit/);
    expect(read(project.root, PRICING.path)).toContain('(subtotal + shipping) * rate');
  });

  it('is never applied as if it were the whole change when the cut falls between two edits', async () => {
    // Cut right after the first edit: what is left reads as a complete, smaller change.
    const chat = scripted({ calls: [propose('p1', 'Two files', [PRICING])], stop: 'length' }, { calls: [propose('p2', 'Discount covers items only', [PRICING])] });
    const { project, out } = run(chat);
    await expect(out).resolves.toMatchObject({ kind: 'change', title: 'Discount covers items only' });
    expect(chat.requests).toHaveLength(2);
    // The cut call itself doesn't go back to the provider (its JSON may be unfinished): the model is told in words.
    const back = sentBack(chat.requests[1]);
    expect(back).not.toContain('Two files');
    expect(back).toMatch(/Nothing in it was run/);
    expect(back).toMatch(/smaller/);
    expect(read(project.root, PRICING.path)).toContain('(subtotal + shipping) * rate');
  });

  it('runs none of its other tool calls either', async () => {
    const chat = scripted({ calls: [{ id: 'r1', name: 'read_file', args: { path: 'src/lib/pricing.ts' } }], stop: 'length' }, { text: 'The discount is applied in src/lib/pricing.ts:32.' });
    const { steps, out } = run(chat);
    await expect(out).resolves.toEqual({ kind: 'answer', text: 'The discount is applied in src/lib/pricing.ts:32.' });
    expect(steps.filter((s) => s.startsWith('Reading'))).toEqual([]);
  });

  it('says so when what is left of a budget was all the room it had', async () => {
    const cut = { calls: [propose('p1', 'Two files', [PRICING])], stop: 'length' as const };
    const chat = scripted(cut);
    const tight: Admit = () => ({ maxTokens: 4200, fallback: false, settle: () => undefined });
    await expect(run(chat, tight).out).rejects.toMatchObject({ code: 'budget', message: expect.stringMatching(/^Claude ran out of room before finishing: what is left of your budget let it answer in only about 4K tokens\./) });
    expect(chat.requests).toHaveLength(2);
  });

  it('shows an answer that was cut as cut, with why', async () => {
    const chat = scripted({ text: 'This is a long answer that got cut', stop: 'length' });
    await expect(run(chat).out).resolves.toEqual({ kind: 'answer', text: 'This is a long answer that got cut … (Cut short: the answer reached its length limit.)' });
    expect(chat.requests).toHaveLength(1);
    const tight: Admit = () => ({ maxTokens: 4000, fallback: false, settle: () => undefined });
    const short = await run(scripted({ text: 'This is a long answer that got cut', stop: 'length' }), tight).out;
    expect(short).toMatchObject({ kind: 'answer', text: expect.stringMatching(/^This is a long answer that got cut … \(Cut short: what is left of your budget let Claude answer in only about 4K tokens\. Raise the limit in Settings → Usage and budget for a full answer\.\)$/) });
  });

  it('with nothing written at all stops at once, as before', async () => {
    const chat = scripted({ stop: 'length' });
    await expect(run(chat).out).rejects.toMatchObject({ message: 'Claude ran out of room before finishing. Try a smaller request.' });
    expect(chat.requests).toHaveLength(1);
  });
});

describe('several changes proposed in one turn', () => {
  it('land as one change with every edit, named for all of them', async () => {
    const chat = scripted({ calls: [propose('p1', 'Discount covers items only', [PRICING]), propose('p2', 'Money is formatted by formatMoney', [MONEY])] });
    const { out } = run(chat);
    const change = await out;
    expect(change).toMatchObject({ kind: 'change', title: 'Discount covers items only · Money is formatted by formatMoney', summary: 'Discount covers items only. Money is formatted by formatMoney.' });
    expect(change.kind === 'change' && change.edits.map((e) => e.path)).toEqual([PRICING.path, MONEY.path]);
    expect(chat.requests).toHaveLength(1);
  });

  it('keep a title that fits when there are many', async () => {
    const long = 'A title as long as the sixty characters a change may have, x';
    const chat = scripted({ calls: [propose('p1', long, [PRICING]), propose('p2', long, [MONEY]), propose('p3', 'Third', [{ path: 'src/new.ts', old_string: '', new_string: 'export {};\n' }])] });
    const change = await run(chat).out;
    expect(change.kind === 'change' && change.title).toBe(`${long} (and 2 more)`);
    expect(change.kind === 'change' && change.edits).toHaveLength(3);
  });

  it('land together or not at all: when one doesn’t apply, none is written and the model is asked for one call', async () => {
    const wrong = { ...MONEY, old_string: 'export function nothing' };
    const chat = scripted(
      { calls: [propose('p1', 'Discount covers items only', [PRICING]), propose('p2', 'Money', [wrong])] },
      { calls: [propose('p3', 'Discount and money', [PRICING, MONEY])] },
    );
    const { out } = run(chat);
    await expect(out).resolves.toMatchObject({ kind: 'change', title: 'Discount and money' });
    const results = (chat.requests[1].messages.at(-1) as Extract<Msg, { role: 'tool' }>).results;
    expect(results.map((r) => [r.id, r.error])).toEqual([['p1', true], ['p2', true]]);
    expect(results[1].output).toMatch(/was not found in src\/lib\/money\.ts/);
    expect(results[0].output).toMatch(/one propose_change with every edit/);
  });

  it('one of them not shaped as a change stops all of them', async () => {
    const chat = scripted({ calls: [propose('p1', 'Discount covers items only', [PRICING]), { id: 'p2', name: 'propose_change', args: { __invalid: '{"title": "Mon' } }] }, { text: 'I could not finish.' });
    const { project, out } = run(chat);
    await expect(out).resolves.toEqual({ kind: 'answer', text: 'I could not finish.' });
    const results = (chat.requests[1].messages.at(-1) as Extract<Msg, { role: 'tool' }>).results;
    expect(results.every((r) => r.error)).toBe(true);
    expect(read(project.root, PRICING.path)).toContain('(subtotal + shipping) * rate');
  });

  it('a read asked for beside a change that didn’t apply is still answered', async () => {
    const wrong = { ...PRICING, old_string: 'const discount = nothing;' };
    const chat = scripted({ calls: [propose('p1', 'Discount', [wrong]), { id: 'r1', name: 'read_file', args: { path: 'src/lib/money.ts' } }] }, { calls: [propose('p2', 'Discount covers items only', [PRICING])] });
    await expect(run(chat).out).resolves.toMatchObject({ kind: 'change' });
    const results = (chat.requests[1].messages.at(-1) as Extract<Msg, { role: 'tool' }>).results;
    expect(results.map((r) => r.id)).toEqual(['p1', 'r1']);
    expect(results[1].output).toMatch(/^src\/lib\/money\.ts \(lines/);
  });
});
