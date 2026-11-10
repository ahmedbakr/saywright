/**
 * A check on a whole row receives "Total$78.40" when "$80.80" was expected:
 * pick out the part that has the same shape as the expectation.
 */
export function focusOn(received: string | undefined, expected: string | undefined): string | undefined {
  if (!received || !expected || received === expected) return received;
  const shape = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+');
  if (shape === expected || !/\\d\+/.test(shape)) return received;
  return new RegExp(shape).exec(received)?.[0] ?? received;
}

/** A check of whether something is checked, as said: "checked", "ticked", "selected", "on"; or not. Null for any other value. */
export function stateWord(said: string): 'checked' | 'not checked' | null {
  const t = said.toLowerCase().replace(/[.!?“”"'‘’]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(?:be )?(?:un(?:checked|ticked|selected)|not (?:be )?(?:checked|ticked|selected|chosen|on)|deselected|cleared|off|غير (?:محدد|مفعل|مختار))$/.test(t)) return 'not checked';
  if (/^(?:be )?(?:checked|ticked|selected|chosen|on|محدد|مفعل|مختار)$/.test(t)) return 'checked';
  return null;
}

/**
 * Why a check can't be about this element, as a sentence; null when it can. An embedded frame (`<iframe>`) is
 * another page: the test's locators work in the page around it, so nothing inside it can be checked from there.
 */
export function uncheckable(el: { tag: string }): string | null {
  if (el.tag.toLowerCase() === 'iframe') return 'What is inside an embedded frame can’t be checked from the page around it: a test can only check what this page shows itself.';
  return null;
}

/** What a check says should be, after the thing it is about: "should show “$80.80”", "should be checked". */
export function shouldBe(e: { expected: string; field?: string; not?: boolean }, quote = (s: string) => `“${s}”`): string {
  if (e.field === 'checked') return e.expected === 'not checked' ? 'should not be checked' : 'should be checked';
  if (e.field === 'state') return e.expected === 'not selected' ? 'should not be selected' : `should be ${e.expected}`;
  if (e.field === 'select') return `should ${e.not ? 'not ' : ''}have ${quote(e.expected)} chosen`;
  if (e.field === 'name') return `should ${e.not ? 'not ' : ''}be named ${quote(e.expected)}`;
  return `should ${e.not ? 'not ' : ''}show ${quote(e.expected)}`;
}

/** The states a check can say an element is in, as Playwright's own matchers check them. */
export type ElementState = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'selected' | 'not selected';

/** The phrasings Write test understands as a check, for a sentence shaped like one that isn't. */
export const CHECK_PHRASES = 'Try: this should show …, this should not show …, this should be visible/hidden/enabled/disabled/checked.';

/**
 * Each check's number in the test written from them ([check 1], [check 2]…): they come in the test in the order of
 * the steps they follow, those after the same step in the order they were said.
 */
export function checkNumbers(checks: { after?: number }[], steps: number): number[] {
  const at = (c: { after?: number }) => Math.max(0, Math.min(steps, c.after ?? steps));
  const order = checks.map((c, i) => ({ i, at: at(c) })).sort((a, b) => a.at - b.at || a.i - b.i);
  const out: number[] = Array.from({ length: checks.length }, () => 0);
  order.forEach((o, n) => (out[o.i] = n + 1));
  return out;
}
