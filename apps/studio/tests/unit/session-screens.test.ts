/**
 * What the screen said, as a report checks it: a page in full as it first showed, then what changed once the screen
 * settled after each action, as a short diff tied to that action. With it the report can find a wrong total that
 * nobody mentioned, in the code behind the action.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_COUNTS, type SessionMeta } from '../../shared/session';
import { analyze } from '../../server/sessions/analyze';
import { evidencePack } from '../../server/sessions/report';
import { lineDiff, screenTexts, type Look } from '../../server/sessions/screens';
import type { StoredEvent } from '../../server/sessions/store';
import { tempShop } from './helpers';

const T0 = 1_700_000_000_000;
const URL = 'http://localhost:5174/#/checkout';
const CHECKOUT = ['Checkout', 'Order summary', 'Coupon', 'Apply', 'Subtotal', '$86.00', 'Shipping', '$12.00', 'Total', '$98.00', 'Pay $98.00', 'Free returns within 30 days'];
const APPLIED = ['Checkout', 'Order summary', 'Coupon', 'SAVE20', 'Remove', 'Subtotal', '$86.00', 'Shipping', '$12.00', 'Discount (SAVE20)', '−$19.60', 'Total', '$78.40', 'Pay $78.40', 'Free returns within 30 days'];

describe('what changed between two reads of the screen', () => {
  it('shows what appeared and what went away, with the lines just before each change (a value’s label)', () => {
    const d = lineDiff(CHECKOUT, APPLIED);
    expect(d.lines).toEqual([
      '…',
      '  Order summary',
      '  Coupon',
      '- Apply',
      '+ SAVE20',
      '+ Remove',
      '  Subtotal',
      '…',
      '  Shipping',
      '  $12.00',
      '+ Discount (SAVE20)',
      '+ −$19.60',
      '  Total',
      '- $98.00',
      '- Pay $98.00',
      '+ $78.40',
      '+ Pay $78.40',
      '  Free returns within 30 days',
    ]);
    expect(d.changed).toBe(9);
  });

  it('is empty when nothing changed, and whole when everything did', () => {
    expect(lineDiff(CHECKOUT, CHECKOUT)).toEqual({ lines: [], changed: 0 });
    expect(lineDiff(['a', 'b'], ['c'])).toEqual({ lines: ['- a', '- b', '+ c'], changed: 3 });
  });

  it('stays quick on long pages', () => {
    const page = Array.from({ length: 400 }, (_, i) => `Row ${i}: ${i * 3} items`);
    const next = page.map((l, i) => (i % 50 === 7 ? `${l} (updated)` : l));
    const started = performance.now();
    const d = lineDiff(page, next);
    expect(performance.now() - started).toBeLessThan(200);
    expect(d.changed).toBe(16);
  });
});

describe('the reads of a session', () => {
  const click = { id: 'E3', t: T0 + 2000, kind: 'action' as const, text: 'Clicked the “Apply” button', src: 'src/components/CouponField.tsx:45:7' };
  const look = (t: number, reason: string, lines: string[], action: Look['action'] = null, url = URL): Look => ({ t, url, reason, text: lines.join('\n'), action });

  it('gives a page in full, then what an action changed, and nothing for a read that found no change', () => {
    const screens = screenTexts([look(T0 + 300, 'start', CHECKOUT), look(T0 + 2800, 'after', APPLIED, click), look(T0 + 5000, 'mark', APPLIED)]);
    expect(screens).toHaveLength(2);
    expect(screens[0]).toMatchObject({ moment: 'start', diff: false, lines: CHECKOUT });
    expect(screens[1]).toMatchObject({ moment: 'after', diff: true, after: { id: 'E3', text: 'Clicked the “Apply” button' } });
    expect(screens[1].lines).toContain('+ −$19.60');
  });

  it('gives another page in full', () => {
    const screens = screenTexts([look(T0, 'start', CHECKOUT), look(T0 + 3000, 'navigation', ['Shop', 'Stoneware pour-over set', '$54.00'], null, 'http://localhost:5174/#/shop')]);
    expect(screens.map((s) => s.diff)).toEqual([false, false]);
  });

  it('keeps a long session’s reads within bounds, spread over it', () => {
    const many = Array.from({ length: 1000 }, (_, i) => look(T0 + i * 1000, 'after', [...CHECKOUT, `Updated ${i}`], click));
    const screens = screenTexts(many);
    expect(screens.length).toBeLessThanOrEqual(150);
    expect(screens.at(-1)!.t - screens[0].t).toBeGreaterThan(900_000);
  });
});

describe('a session nobody narrated', () => {
  // The sample shop's bug: SAVE20 takes 20% off shipping too. Nothing errs, fails or is said.
  const meta: SessionMeta = { id: 'q', name: 'Coupon', appUrl: 'http://localhost:5174/', source: 'studio', lang: 'en', startedAt: T0, endedAt: T0 + 9000, status: 'processing', counts: { ...EMPTY_COUNTS }, audioSeconds: 0, video: null };
  const field = { src: 'src/components/CouponField.tsx:44:7', name: 'TextField', tag: 'input', role: 'textbox', label: 'Coupon', text: '', rect: [10, 10, 200, 40] as [number, number, number, number], locator: "page.getByTestId('coupon-input')" };
  const apply = { src: 'src/components/CouponField.tsx:45:7', name: 'Button', tag: 'button', role: 'button', label: 'Apply', text: 'Apply', rect: [220, 10, 60, 40] as [number, number, number, number], locator: "page.getByTestId('coupon-apply')", path: 'App › Checkout › OrderSummary › CouponField › Button' };
  const events = [
    { seq: 1, t: T0 + 100, type: 'page', url: URL, title: 'Checkout', referrer: '', viewport: [1200, 800, 1], ua: 'x', lang: 'en', reload: false },
    { seq: 2, t: T0 + 400, type: 'dom', reason: 'start', url: URL, title: 'Checkout', headings: ['Checkout'], text: CHECKOUT.join('\n') },
    { seq: 3, t: T0 + 2000, type: 'input', el: field, value: 'SAVE20', masked: false },
    { seq: 4, t: T0 + 2600, type: 'click', x: 1, y: 1, button: 0, pointer: 'mouse', count: 1, el: apply },
    { seq: 5, t: T0 + 3400, type: 'dom', reason: 'after', url: URL, title: 'Checkout', headings: ['Checkout'], text: APPLIED.join('\n') },
  ].map((e) => ({ ...e, page: 'p' })) as unknown as StoredEvent[];
  const analysis = analyze(meta, events, [], []);

  it('ties what the screen showed to the action before it', () => {
    const clicked = analysis.timeline.find((x) => x.text.startsWith('Clicked'))!;
    expect(analysis.screens?.[1].after).toEqual({ id: clicked.id, text: clicked.text });
  });

  it('gives the AI the change and the code that made it, without anything having been said', () => {
    const pack = evidencePack({ meta, analysis, project: tempShop(), shotPath: (n) => n, previous: null }).text;
    const screen = pack.slice(pack.indexOf('<screen_text'), pack.indexOf('</screen_text>'));
    expect(screen).toMatch(/\[00:00\] \/#\/checkout when recording started \(in full\):\n {2}Checkout\n {2}Order summary/);
    expect(screen).toMatch(/\[00:03\] after E\d+ Clicked the “Apply” button:\n/);
    expect(screen).toContain('  + −$19.60');
    expect(screen).toContain('  - $98.00');
    // The action's component, and the pricing code it imports, ranked by the words that changed (Discount, Total).
    expect(pack).toContain('--- src/components/CouponField.tsx');
    expect(pack).toMatch(/--- src\/lib\/pricing\.ts \(imported by src\/components\/CouponField\.tsx\)/);
    expect(pack).toContain('  32|   const discount = round2((subtotal + shipping) * rate);');
  });

  it('says how to read it', () => {
    const pack = evidencePack({ meta, analysis, project: tempShop(), shotPath: (n) => n, previous: null }).text;
    expect(pack).toContain('format="diff: + appeared, - went away, two spaces unchanged, … unchanged lines left out"');
  });
});
