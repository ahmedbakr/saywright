import { describe, expect, it } from 'vitest';
import { annotate } from '../src/annotate';

describe('annotate', () => {
  it('adds source and name attributes right after the tag name', () => {
    const code = `export const A = () => (\n  <div className="x">\n    <Button variant="link">Go</Button>\n  </div>\n);`;
    const out = annotate(code, '/p/src/A.tsx', 'src/A.tsx')!;
    expect(out.count).toBe(2);
    expect(out.code).toContain('<div data-ds-src="src/A.tsx:2:3" data-ds-name="div" className="x">');
    expect(out.code).toContain('<Button data-ds-src="src/A.tsx:3:5" data-ds-name="Button" variant="link">');
  });

  it('skips fragments, providers and svg internals but keeps the svg root', () => {
    const code = `const A = () => <><Ctx.Provider value={1}><svg><path d="M0"/></svg></Ctx.Provider><React.Fragment/></>;`;
    const out = annotate(code, '/p/a.tsx', 'a.tsx')!;
    expect(out.count).toBe(1);
    expect(out.code).toContain('<svg data-ds-src="a.tsx:1:43" data-ds-name="svg">');
    expect(out.code).not.toMatch(/Provider data-ds/);
    expect(out.code).not.toMatch(/<path data-ds/);
  });

  it('handles generic components and leaves already-annotated elements alone', () => {
    const code = `const A = () => <List<string> items={[]} />;\nconst B = () => <i data-ds-src="x:1:1" />;`;
    const out = annotate(code, '/p/a.tsx', 'a.tsx')!;
    expect(out.code).toContain('<List<string> data-ds-src="a.tsx:1:17" data-ds-name="List" items');
    expect(out.code).toContain('<i data-ds-src="x:1:1" />');
  });

  it('returns null for files without JSX', () => {
    expect(annotate('export const x = 1;', '/p/a.ts', 'a.ts')).toBeNull();
  });
});
