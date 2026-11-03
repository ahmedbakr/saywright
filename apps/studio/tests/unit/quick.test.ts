import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RefInfo } from '../../shared/api';
import { Project } from '../../server/project';
import { quickEdit } from '../../server/quick';
import { srcOf, tempShop } from './helpers';

const ref = (role: string, src: string, name: string, text = ''): RefInfo => ({ role, src, name, label: name, text });

describe('quickEdit on the sample shop', () => {
  it('copies the look of the Pay button onto Apply, one size smaller', () => {
    const p = tempShop();
    const apply = srcOf(p, 'src/components/CouponField.tsx', '<Button variant="secondary"');
    const pay = srcOf(p, 'src/components/OrderSummary.tsx', '<Button size="lg"');
    const r = quickEdit('make this look like that, but smaller', [ref('this', apply, 'Button', 'Apply'), ref('that', pay, 'Button', 'Pay $98.00')], p);
    expect(r?.kind).toBe('edit');
    if (r?.kind !== 'edit') return;
    expect(r.edits[0].path).toBe('src/components/CouponField.tsx');
    // Pay is primary (default) and lg; one smaller is md (default) -> both props removed.
    expect(r.edits[0].after).toContain('<Button type="submit" data-testid="coupon-apply">');
    expect(r.title).toBe('“Apply” Button looks like “Pay $98.00” Button, but smaller');
  });

  it('maps colour words through design-system synonyms', () => {
    const p = tempShop();
    const apply = srcOf(p, 'src/components/CouponField.tsx', '<Button variant="secondary"');
    const r = quickEdit('make it red', [ref('this', apply, 'Button', 'Apply')], p);
    expect(r?.kind === 'edit' && r.edits[0].after).toContain('<Button variant="danger" size="sm"');
  });

  it('steps through ordered sizes and stops at the end', () => {
    const p = tempShop();
    const total = srcOf(p, 'src/components/OrderSummary.tsx', '<SummaryRow label="Total"');
    const r = quickEdit('make this bigger', [ref('this', total, 'SummaryRow', 'Total')], p);
    expect(r).toEqual(expect.objectContaining({ kind: 'message' }));
    const smaller = quickEdit('make this smaller', [ref('this', total, 'SummaryRow', 'Total')], p);
    expect(smaller?.kind === 'edit' && smaller.edits[0].after).toContain('emphasis="strong" data-testid="summary-total"');
  });

  it('renames to the quoted words only, and leaves “everywhere” to the AI', () => {
    const p = tempShop();
    const apply = srcOf(p, 'src/components/CouponField.tsx', '<Button variant="secondary"');
    const one = quickEdit('Rename "Apply" to "Use code"', [ref('this', apply, 'Button', 'Apply')], p);
    expect(one?.kind === 'edit' && one.edits[0].after).toMatch(/>\s*Use code\s*<\/Button>/);
    const all = quickEdit('Rename "Apply" to "Use code" everywhere it appears', [ref('this', apply, 'Button', 'Apply')], p);
    expect(all).toEqual({ kind: 'needs-ai', why: expect.stringContaining('everywhere') });
  });

  it('renames text held in a prop (SummaryRow label)', () => {
    const p = tempShop();
    const sub = srcOf(p, 'src/components/OrderSummary.tsx', '<SummaryRow label="Subtotal"');
    const r = quickEdit('rename this to Items', [ref('this', sub, 'SummaryRow', 'Subtotal')], p);
    expect(r?.kind === 'edit' && r.edits[0].after).toContain('<SummaryRow label="Items"');
  });

  it('at the largest size, offers the AI and the design system’s file instead of stopping there', () => {
    const p = tempShop();
    const pay = srcOf(p, 'src/components/OrderSummary.tsx', '<Button size="lg"');
    const r = quickEdit('make it bigger', [ref('this', pay, 'Button', 'Pay $98.00')], p);
    expect(r).toEqual({
      kind: 'message',
      tone: 'info',
      text: '“Pay $98.00” Button is already the largest size (“lg”) in your design system.',
      next: [{ kind: 'ask-ai' }, { kind: 'open', src: 'src/ds/Button.tsx:1:1' }],
    });
  });

  it('says why a label built from code needs the AI, and where it is written', () => {
    const p = tempShop();
    const pay = srcOf(p, 'src/components/OrderSummary.tsx', '<Button size="lg"');
    const r = quickEdit('rename to Place order', [ref('this', pay, 'Button', 'Pay $98.00')], p);
    expect(r).toEqual({ kind: 'needs-ai', why: '“Pay $98.00” Button’s text is built from code (“Pay {money(totals.total)}”), so changing it needs an AI.', src: pay });
  });

  it('hands unknown requests to Claude', () => {
    const p = tempShop();
    const apply = srcOf(p, 'src/components/CouponField.tsx', '<Button variant="secondary"');
    expect(quickEdit('why is this here?', [ref('this', apply, 'Button')], p)).toBeNull();
    expect(quickEdit('make this sparkle', [ref('this', apply, 'Button')], p)).toBeNull();
    expect(quickEdit('make this primary', [], p)).toBeNull();
  });
});

describe('quick edits in a very long component', () => {
  // 8,000 rows, about 1 MB: a generated table or a component that grew for years.
  const rows = Array.from({ length: 8000 }, (_, k) => `      <div className="cell cell-${k}" data-k="${k}"><b>Cell ${k}</b><button onClick={() => setN(${k})}>Go ${k}</button></div>`);
  const code = ['import { useState } from "react";', '', 'export function Big() {', '  const [n, setN] = useState(0);', '  return (', '    <main className="big">', ...rows, '    </main>', '  );', '}', ''].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-big-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/Big.tsx'), code);
  const p = new Project(dir, 'http://localhost:5174');
  // Row 4,000 is on line 4,007, its <b> at column 53.
  const at = (col: number) => [ref('this', `src/Big.tsx:4007:${col}`, 'div')];

  it('removes a row in moments, touching nothing else', () => {
    // Processor time, not the clock: the machine running the tests may be busy with other work. A Node without the
    // thread's own time gives the whole process's, other test files' work included, so the bound is looser there.
    const thread = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage.bind(process) : null;
    const started = thread ? thread() : process.cpuUsage();
    const r = quickEdit('remove this', at(7), p);
    const used = thread ? thread(started) : process.cpuUsage(started);
    expect((used.user + used.system) / 1000).toBeLessThan(thread ? 2000 : 8000);
    expect(r?.kind).toBe('edit');
    if (r?.kind !== 'edit') return;
    expect(r.edits[0].after).toBe(code.replace(`${rows[4000]}\n`, ''));
  });

  it('renames text in it, and refuses an element that isn’t there', () => {
    const r = quickEdit('rename this to Done', at(53), p);
    expect(r?.kind === 'edit' && r.edits[0].after).toBe(code.replace('<b>Cell 4000</b>', '<b>Done</b>'));
    expect(quickEdit('remove this', at(9), p)).toBeNull();
  });
});
