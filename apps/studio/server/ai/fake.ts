/**
 * Deterministic stand-in for the AI, used by the automated tests
 * (SAYWRIGHT_AI=fake). It knows the sample shop's coupon bug, and text changes
 * on whatever was pointed at, and nothing else.
 */
import { parseSrc, type ExpertId } from '@saywright/vite/protocol';
import type { PageReviewRecord } from '../../shared/experts.ts';
import type { AutopilotTurn, TurnInput } from '../autopilot.ts';
import type { JsonRequest } from './service.ts';
import { applyEditSpecs } from './tools.ts';
import type { AgentContext, AgentInput, AgentOutput, AgentProvider } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeProvider implements AgentProvider {
  readonly source = 'fake' as const;
  readonly model = 'fake-claude';

  async run(input: AgentInput, ctx: AgentContext): Promise<AgentOutput> {
    const t = input.text.toLowerCase();
    ctx.progress('Thinking');
    await sleep(250);

    // From a page review: the missing meta description is the finding the stand-in knows how to fix.
    if (input.brief?.includes('[SEO-19]')) {
      ctx.progress('Reading', 'index.html');
      await sleep(150);
      const edits = applyEditSpecs(ctx.project, [
        { path: 'index.html', old_string: '</title>', new_string: '</title>\n    <meta name="description" content="Tidewell: linen, ceramics and small goods for slow mornings, with free shipping over $75." />' },
      ]);
      return { kind: 'change', title: 'Adds a meta description', summary: 'index.html now describes the shop for search results and link previews.', edits };
    }

    // A stand-in that “fixes” a failing test by weakening the test itself: what the studio must never take for a fix.
    if (input.mode === 'fix' && input.test && /\b(?:change|edit) the test\b/i.test(input.text)) {
      // Whatever the check expects (words, or an amount's pattern), it is made to expect any amount at all.
      const check = /\.to(?:Contain|Have)Text\((?:'[^'\n]*'|\/(?:\\.|[^/\n])+\/[a-z]*)\)/.exec(ctx.project.read(input.test.path))?.[0] ?? "toContainText('$80.80')";
      const edits = applyEditSpecs(ctx.project, [{ path: input.test.path, old_string: check, new_string: ".toContainText('$')" }]);
      return { kind: 'change', title: 'Loosens the check', summary: 'The test now accepts any amount.', edits };
    }

    if (input.mode === 'fix' || /\bfix\b/.test(t)) {
      ctx.progress('Reading', 'src/lib/pricing.ts');
      await sleep(150);
      const edits = applyEditSpecs(ctx.project, [
        {
          path: 'src/lib/pricing.ts',
          old_string: 'const discount = round2((subtotal + shipping) * rate);',
          new_string: 'const discount = round2(subtotal * rate);',
        },
      ]);
      return {
        kind: 'change',
        title: 'Discount covers items only',
        summary: 'SAVE20 applies to items, so the discount no longer includes shipping.',
        edits,
      };
    }

    // "make it say “…”" on what was pointed at, wherever it was written: shows the element reached the agent with its place in the code.
    const say = /\bsay\s+["“]([^"”]+)["”]/i.exec(input.text);
    const ref = input.refs[0];
    const at = ref?.src ? parseSrc(ref.src) : null;
    if (say && at && ref.text) {
      ctx.progress('Reading', at.file);
      const edits = applyEditSpecs(ctx.project, [{ path: at.file, old_string: ref.text, new_string: say[1] }]);
      return { kind: 'change', title: `Now says “${say[1]}”`, summary: `Changed the text in ${at.file}:${at.line}.`, edits };
    }

    if (/^\s*(why|what|where|how)\b/.test(t)) {
      return {
        kind: 'answer',
        text: 'The total comes from calcTotals in src/lib/pricing.ts:32, which applies the coupon rate to subtotal plus shipping. SAVE20 is defined for items only (src/lib/pricing.ts:13), so shipping should not be discounted.',
      };
    }

    return { kind: 'answer', text: `I would need the real Claude for “${input.text}”. Set ANTHROPIC_API_KEY to try it.` };
  }
}

/** The AI expert's judgement of a reviewed page, made up from its checks: the same every time. */
export function fakeExpertAsk(r: PageReviewRecord, expert: ExpertId) {
  return async <T>(_req: JsonRequest<T>): Promise<{ value: T; model: string }> => {
    await sleep(200);
    const checks = r.checks.filter((c) => c.expert === expert);
    const last = checks.length > 1 ? checks[checks.length - 1].key : null;
    const value = {
      summary: checks.length ? 'The first problem listed matters most on this page; the rest can wait.' : 'Nothing serious on this page.',
      verdicts: checks.map((c) => (c.key === last ? { check: c.key, verdict: 'dismissed', note: 'Harmless on this page.' } : { check: c.key, verdict: 'confirmed', note: 'It matters on this page.' })),
      findings: [{ rule: 'heuristic', severity: 'medium', title: 'Say what the main button does', what: 'The main button’s words don’t say what happens next.', fix: 'Name the action it takes.', element: 'e1', before: 'Apply', after: 'Apply code' }],
    };
    return { value: value as T, model: 'fake' };
  };
}

/**
 * Autopilot on the sample shop, the same every time: to the checkout (from the shop, with a product in the cart), the
 * SAVE20 coupon, and the problem that shows (the discount takes 20% off shipping too). Anywhere else it stops.
 */
export function fakeAutopilotAsk(input: TurnInput) {
  return async <T>(_req: JsonRequest<T>): Promise<{ value: T; model: string }> => {
    await sleep(150);
    const s = input.snapshot;
    const at = (re: RegExp) => s.controls.findIndex((c) => re.test(c.name)) + 1;
    const did = (re: RegExp) => input.history.some((h) => h.ok && re.test(h.did));
    let turn: AutopilotTurn;
    const checkout = s.headings.some((h) => /^Checkout$/i.test(h));
    if (!checkout && !did(/Add to cart/) && at(/^Add to cart$/i)) turn = { thought: 'Put a product in the cart first.', action: { kind: 'click', control: at(/^Add to cart$/i) }, findings: [] };
    else if (!checkout && at(/^Checkout$/i)) turn = { thought: 'Go to the checkout.', action: { kind: 'click', control: at(/^Checkout$/i) }, findings: [] };
    else if (!did(/SAVE20/) && at(/coupon/i)) turn = { thought: 'Try the SAVE20 coupon.', action: { kind: 'fill', control: at(/coupon/i), value: 'SAVE20' }, findings: [] };
    else if (!did(/Clicked “Apply”/) && at(/^Apply$/i)) turn = { thought: 'Apply it.', action: { kind: 'click', control: at(/^Apply$/i) }, expect: '20% off the items', findings: [] };
    else if (did(/Clicked “Apply”/))
      turn = {
        thought: 'Check the totals with the coupon applied.',
        action: { kind: 'done' },
        // About the applied coupon (its Remove button: the Apply button is gone once it is applied).
        findings: [{ severity: 'high', title: 'SAVE20 takes 20% off shipping too', expected: 'A discount of 20% of the items only', actual: 'The discount is 20% of the items plus shipping', control: at(/^Remove$/i) || undefined }],
        summary: 'Added a product, opened the checkout and applied SAVE20: the discount is taken from shipping too.',
      };
    else turn = { thought: 'Nothing here I know how to test.', action: { kind: 'done' }, findings: [], summary: 'Looked at the page and stopped.' };
    return { value: turn as T, model: 'fake' };
  };
}
