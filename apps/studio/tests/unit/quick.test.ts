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

  it('several picked: the same edit on each, as one change (once per place in the code)', () => {
    const p = tempShop();
    const apply = srcOf(p, 'src/components/CouponField.tsx', '<Button variant="secondary"');
    const pay = srcOf(p, 'src/components/OrderSummary.tsx', '<Button size="lg"');
    const r = quickEdit('make these red', [ref('pin 1', apply, 'Button', 'Apply'), ref('pin 2', pay, 'Button', 'Pay $98.00'), ref('pin 3', apply, 'Button', 'Apply')], p);
    expect(r?.kind).toBe('edit');
    if (r?.kind !== 'edit') return;
    expect(r.edits.map((e) => e.path).sort()).toEqual(['src/components/CouponField.tsx', 'src/components/OrderSummary.tsx']);
    expect(r.edits.find((e) => e.path.endsWith('CouponField.tsx'))!.after).toContain('<Button variant="danger" size="sm"');
    expect(r.edits.find((e) => e.path.endsWith('OrderSummary.tsx'))!.after).toContain('variant="danger"');
    expect(r.title).toMatch(/\(2 picked\)$/);
    // One that can't be done stops them all, saying which and why.
    const total = srcOf(p, 'src/components/OrderSummary.tsx', '<SummaryRow label="Total"');
    const bigger = quickEdit('make these bigger', [ref('pin 1', apply, 'Button', 'Apply'), ref('pin 2', total, 'SummaryRow', 'Total')], p);
    expect(bigger).toMatchObject({ kind: 'message', text: expect.stringMatching(/^Not done for any of them: “Total” SummaryRow: /) });
  });

  it('maps colour words through design-system synonyms', () => {
    const p = tempShop();
    const apply = srcOf(p, 'src/components/CouponField.tsx', '<Button variant="secondary"');
    const r = quickEdit('make it red', [ref('this', apply, 'Button', 'Apply')], p);
    expect(r?.kind === 'edit' && r.edits[0].after).toContain('<Button variant="danger" size="sm"');
  });

  it('sets a value only when the rest of the request names the element or the prop, never when it asks for more', () => {
    const p = tempShop();
    const apply = [ref('this', srcOf(p, 'src/components/CouponField.tsx', '<Button variant="secondary"'), 'Button', 'Apply')];
    for (const said of ['make the Apply button red', 'make it a ghost button', 'use the danger variant', 'ghost']) expect(quickEdit(said, apply, p)?.kind, said).toBe('edit');
    // “link” is one of Button's variants, and “danger” one of its values: neither is what these ask for.
    for (const said of ['make it link to /terms', 'make the danger zone collapsible', 'make this primary action optional', 'set the default to express', 'turn this into a dropdown']) expect(quickEdit(said, apply, p), said).toBeNull();
  });

  it('never resizes, renames, moves or removes for a question, a condition or a “don’t”', () => {
    const p = tempShop();
    const pay = [ref('this', srcOf(p, 'src/components/OrderSummary.tsx', '<Button size="lg"'), 'Button', 'Pay $98.00')];
    for (const said of ["don't make it smaller", 'is this smaller than 44 pixels?', 'make this smaller on mobile', 'make it secondary when disabled', 'the label reads wrong, fix the typo', 'add a tooltip that says Secure payment', 'rename the CSS class to btn-primary'])
      expect(quickEdit(said, pay, p), said).toBeNull();
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
    // “This” with nothing pointed at names nothing: said, free, rather than an AI asked to guess.
    expect(quickEdit('make this primary', [], p)).toMatchObject({ kind: 'message', text: expect.stringMatching(/Point at what you mean/) });
    // Named in words, the AI can still find it.
    expect(quickEdit('make the pay button primary', [], p)).toBeNull();
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
    // Nothing is written there (the code changed since it was selected): said, not guessed, nor sent to an AI unasked.
    expect(quickEdit('remove this', at(9), p)).toMatchObject({ kind: 'message', next: [{ kind: 'ask-ai' }] });
  });
});

describe('quick edits after the code changed under the selection', () => {
  const code = `export function Toolbar() {
  return (
    <div className="toolbar">
      <Button>Export</Button>
      <Button>Print</Button>
    </div>
  );
}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-moved-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/Toolbar.tsx'), code);
  const p = new Project(dir, 'http://localhost:5174');
  // Selected while “Export” was on line 4.
  const exportRef = [ref('this', 'src/Toolbar.tsx:4:7', 'Button', 'Export')];

  it('another element now at its place: the one that says what was selected is edited, found again nearby', () => {
    // Someone adds an Import button above it in their editor.
    fs.writeFileSync(path.join(dir, 'src/Toolbar.tsx'), code.replace('      <Button>Export</Button>', '      <Button>Import</Button>\n      <Button>Export</Button>'));
    const r = quickEdit('rename this to Download', exportRef, p);
    expect(r?.kind).toBe('edit');
    if (r?.kind !== 'edit') return;
    expect(r.title).toBe('Rename “Export” Button to “Download”');
    expect(r.edits[0].after).toContain('<Button>Import</Button>\n      <Button>Download</Button>');
  });

  it('says when the code it changes draws more than what was pointed at, and the component it is part of', () => {
    fs.writeFileSync(path.join(dir, 'src/Toolbar.tsx'), code);
    const r = quickEdit('rename this to Download', [{ ...exportRef[0], same: 3 }], p);
    expect(r?.kind).toBe('edit');
    if (r?.kind !== 'edit') return;
    expect(r.title).toBe('Rename “Export” Button to “Download” (all 3 on this page)');
    expect(r.summary).toMatch(/draws it 3 times on this page .*this changes them all/);
    expect(r.component).toBe('Toolbar');
  });

  it('nothing near says what was selected (the page doesn’t show an undo yet): what is at its place is it', () => {
    fs.writeFileSync(path.join(dir, 'src/Toolbar.tsx'), code.replace('<Button>Export</Button>', '<Button>Export all</Button>'));
    const r = quickEdit('rename this to Download', [ref('this', 'src/Toolbar.tsx:4:7', 'Button', 'Export now')], p);
    expect(r?.kind === 'edit' && r.edits[0].after).toContain('<Button>Download</Button>');
  });

  it('when it can’t be told which one it is, it says so', () => {
    fs.writeFileSync(path.join(dir, 'src/Toolbar.tsx'), code.replace('      <Button>Export</Button>', '      <Button>Import</Button>\n      <Button>Export</Button>\n      <Button>Export</Button>'));
    expect(quickEdit('remove this', exportRef, p)).toMatchObject({ kind: 'message', text: expect.stringMatching(/select it again/) });
  });
});

describe('several picked: each is found in the code as it was, and all are changed in one pass', () => {
  const APP = `import Header from './Header';
import Sidebar from './Sidebar';
import Footer from './Footer';

export default function App() {
  return (
    <div className="app">
      <Header />
      <Sidebar />
      <main>content</main>
      <Footer />
    </div>
  );
}
`;
  const TOOLBAR = `import { Bold, Italic, Underline, Link } from 'lucide-react';
import { Button } from './ds/Button';

export function Toolbar({ a, b }: { a: string; b: string }) {
  return (
    <div className="toolbar">
      <p><Bold /><Italic /><Underline /><Link /></p>
      <p><b>One</b> <i>Two</i> <u>Three</u></p>
      <Button>Save</Button> <Button size="sm">Print</Button>
      <Button variant="ghost">Share</Button>
      <table>
        <tr><td>{a}</td></tr>
        <tr><td>{b}</td></tr>
      </table>
    </div>
  );
}
`;
  const setup = () => {
    const p = tempShop();
    fs.writeFileSync(path.join(p.root, 'src/Multi.tsx'), APP);
    fs.writeFileSync(path.join(p.root, 'src/Toolbar.tsx'), TOOLBAR);
    return p;
  };
  const pick = (p: Project, file: string, needle: string, name: string, text = '') => ref('pin', srcOf(p, file, needle), name, text);
  const after = (r: ReturnType<typeof quickEdit>, file: string) => (r?.kind === 'edit' ? r.edits.find((e) => e.path === file)?.after : undefined);

  it('removes the picked ones, and the imports only they used, even when one removal moves the other', () => {
    const p = setup();
    const two = quickEdit('remove these', [pick(p, 'src/Multi.tsx', '<Header', 'Header'), pick(p, 'src/Multi.tsx', '<Footer', 'Footer')], p);
    expect(after(two, 'src/Multi.tsx')).toBe(APP.replace("import Header from './Header';\n", '').replace("import Footer from './Footer';\n", '').replace('      <Header />\n', '').replace('      <Footer />\n', ''));
    expect(two?.kind === 'edit' && two.title).toBe('Remove Header; Remove Footer (2 picked)');
    const three = quickEdit('remove these', [pick(p, 'src/Multi.tsx', '<Footer', 'Footer'), pick(p, 'src/Multi.tsx', '<main', 'main', 'content'), pick(p, 'src/Multi.tsx', '<Header', 'Header')], p);
    expect(after(three, 'src/Multi.tsx')).toBe(APP.replace("import Header from './Header';\n", '').replace("import Footer from './Footer';\n", '').replace('      <Header />\n', '').replace('      <main>content</main>\n', '').replace('      <Footer />\n', ''));
  });

  it('removes two and three on one line, and rows that draw data with the props only they read', () => {
    const p = setup();
    const r = quickEdit('remove these', [pick(p, 'src/Toolbar.tsx', '<Bold', 'Bold'), pick(p, 'src/Toolbar.tsx', '<Link', 'Link')], p);
    const code = after(r, 'src/Toolbar.tsx')!;
    expect(code).toContain("import { Italic, Underline } from 'lucide-react';");
    expect(code).toContain('<p><Italic /><Underline /></p>');
    const three = quickEdit('remove these', [pick(p, 'src/Toolbar.tsx', '<Bold', 'Bold'), pick(p, 'src/Toolbar.tsx', '<Italic', 'Italic'), pick(p, 'src/Toolbar.tsx', '<Link', 'Link')], p);
    expect(after(three, 'src/Toolbar.tsx')).toContain("import { Underline } from 'lucide-react';");
    expect(after(three, 'src/Toolbar.tsx')).toContain('<p><Underline /></p>');
    const rows = quickEdit('remove these', [pick(p, 'src/Toolbar.tsx', '<tr><td>{a}', 'tr', 'Alice'), pick(p, 'src/Toolbar.tsx', '<Bold', 'Bold')], p);
    const left = after(rows, 'src/Toolbar.tsx')!;
    expect(left).toContain('export function Toolbar({ b }: { a: string; b: string })');
    expect(left).toContain('<tr><td>{b}</td></tr>');
    expect(left).not.toContain('{a}');
    expect(left).toContain('<p><Italic /><Underline /><Link /></p>');
  });

  it('removes across files, and an element inside another picked one goes with it', () => {
    const p = setup();
    const r = quickEdit('remove these', [pick(p, 'src/Multi.tsx', '<Sidebar', 'Sidebar'), pick(p, 'src/Toolbar.tsx', '<Italic', 'Italic')], p);
    expect(after(r, 'src/Multi.tsx')).toBe(APP.replace("import Sidebar from './Sidebar';\n", '').replace('      <Sidebar />\n', ''));
    expect(after(r, 'src/Toolbar.tsx')).toContain('<p><Bold /><Underline /><Link /></p>');
    const nested = quickEdit('remove these', [pick(p, 'src/Toolbar.tsx', '<p><Bold', 'p'), pick(p, 'src/Toolbar.tsx', '<Bold', 'Bold')], p);
    const code = after(nested, 'src/Toolbar.tsx')!;
    expect(code).not.toContain('<Bold');
    expect(code).toContain("import { Button } from './ds/Button';");
    expect(code).not.toContain('lucide-react');
  });

  it('renames, resizes and recolours two and three on one line', () => {
    const p = setup();
    const r = quickEdit('rename these to Done', [pick(p, 'src/Toolbar.tsx', '<b>', 'b', 'One'), pick(p, 'src/Toolbar.tsx', '<i>', 'i', 'Two'), pick(p, 'src/Toolbar.tsx', '<u>', 'u', 'Three')], p);
    expect(after(r, 'src/Toolbar.tsx')).toContain('<p><b>Done</b> <i>Done</i> <u>Done</u></p>');
    const bigger = quickEdit('make these bigger', [pick(p, 'src/Toolbar.tsx', '<Button>Save', 'Button', 'Save'), pick(p, 'src/Toolbar.tsx', '<Button size="sm"', 'Button', 'Print'), pick(p, 'src/Toolbar.tsx', '<Button variant="ghost"', 'Button', 'Share')], p);
    const code = after(bigger, 'src/Toolbar.tsx')!;
    expect(code).toContain('<Button size="lg">Save</Button> <Button>Print</Button>');
    expect(code).toContain('<Button variant="ghost" size="lg">Share</Button>');
    const red = quickEdit('make these red', [pick(p, 'src/Toolbar.tsx', '<Button>Save', 'Button', 'Save'), pick(p, 'src/Toolbar.tsx', '<Button size="sm"', 'Button', 'Print')], p);
    expect(after(red, 'src/Toolbar.tsx')).toContain('<Button variant="danger">Save</Button> <Button size="sm" variant="danger">Print</Button>');
  });

  it('moves one below another with two picked, and says what it can’t do with three', () => {
    const p = setup();
    const two = quickEdit('move this below that', [pick(p, 'src/Multi.tsx', '<Header', 'Header'), pick(p, 'src/Multi.tsx', '<Sidebar', 'Sidebar')], p);
    expect(after(two, 'src/Multi.tsx')).toContain('      <Sidebar />\n      <Header />\n');
    const three = quickEdit('move these below that', [pick(p, 'src/Multi.tsx', '<Header', 'Header'), pick(p, 'src/Multi.tsx', '<Sidebar', 'Sidebar'), pick(p, 'src/Multi.tsx', '<Footer', 'Footer')], p);
    expect(three).toMatchObject({ kind: 'message', text: expect.stringMatching(/one element at a time/) });
  });
});
