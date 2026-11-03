import { describe, expect, it } from 'vitest';
import { CodemodError, moveElement, readProps, findElement, removeElement, setProp, setText } from '../../server/quick/codemods';
import { locOf } from './helpers';

const SRC = `import { Button } from './ds';

export function Bar({ ok }: { ok: boolean }) {
  return (
    <div className="bar">
      <Button variant="secondary" size="sm" onClick={() => {}}>
        Apply
      </Button>
      <Button
        size="lg"
        fullWidth
      >
        Pay {total}
      </Button>
      {ok && <span className="hint">Saved</span>}
      <p>First</p>
      <p>Second</p>
    </div>
  );
}
`;

describe('setProp', () => {
  it('replaces an existing string prop in place', () => {
    const out = setProp(SRC, locOf(SRC, '<Button variant="secondary"'), 'variant', 'primary');
    expect(out).toContain('<Button variant="primary" size="sm"');
  });

  it('adds a missing prop on the same line', () => {
    const out = setProp(SRC, locOf(SRC, '<Button variant="secondary"'), 'tone', 'brand');
    expect(out).toContain('onClick={() => {}} tone="brand">');
  });

  it('adds a missing prop on its own line for multi-line tags', () => {
    const out = setProp(SRC, locOf(SRC, '<Button\n'), 'variant', 'danger');
    expect(out).toContain('        fullWidth\n        variant="danger"\n      >');
  });

  it('removes a prop with its leading whitespace', () => {
    const out = setProp(SRC, locOf(SRC, '<Button variant="secondary"'), 'size', null);
    expect(out).toContain('<Button variant="secondary" onClick');
  });

  it('refuses computed props', () => {
    expect(() => setProp(SRC, locOf(SRC, '<Button variant="secondary"'), 'onClick', 'x')).toThrow(CodemodError);
  });
});

describe('readProps', () => {
  it('reads literals, booleans and dynamic values', () => {
    const f = findElement(SRC, locOf(SRC, '<Button\n'))!;
    expect(readProps(f.el)).toEqual({ size: { kind: 'literal', value: 'lg' }, fullWidth: { kind: 'boolean' } });
  });
});

describe('setText', () => {
  it('replaces plain text and keeps surrounding whitespace', () => {
    const out = setText(SRC, locOf(SRC, '<Button variant="secondary"'), 'Redeem');
    expect(out).toContain('>\n        Redeem\n      </Button>');
  });

  it('escapes JSX-special characters', () => {
    const out = setText(SRC, locOf(SRC, '<p>First'), 'A {b}');
    expect(out).toContain('<p>{"A {b}"}</p>');
  });

  it('refuses text built from expressions', () => {
    expect(() => setText(SRC, locOf(SRC, '<Button\n'), 'Pay now')).toThrow(CodemodError);
  });
});

describe('removeElement', () => {
  it('removes a multi-line element and its whole lines', () => {
    const out = removeElement(SRC, locOf(SRC, '<Button variant="secondary"'));
    expect(out).not.toContain('Apply');
    expect(out).toContain('    <div className="bar">\n      <Button\n');
  });

  it('removes a conditional element together with its {cond && ...} wrapper', () => {
    const out = removeElement(SRC, locOf(SRC, '<span className="hint"'));
    expect(out).not.toContain('ok &&');
    expect(out).not.toContain('Saved');
  });
});

describe('moveElement', () => {
  it('moves an element above a sibling', () => {
    const out = moveElement(SRC, locOf(SRC, '<p>Second'), locOf(SRC, '<p>First'), 'above');
    expect(out.indexOf('Second')).toBeLessThan(out.indexOf('First'));
  });

  it('is a no-op when already in place', () => {
    expect(moveElement(SRC, locOf(SRC, '<p>First'), locOf(SRC, '<p>Second'), 'above')).toBe(SRC);
  });
});
