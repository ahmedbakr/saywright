import { describe, expect, it } from 'vitest';
import { CodemodError, componentAt, moveElement, readProps, findElement, removeElement, removeElementTidy, setProp, setText } from '../../server/quick/codemods';
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

describe('removeElementTidy', () => {
  const ROW = `import { useState } from 'react';
import { Badge, Button, Icon as Glyph } from './ds';
import Tooltip, { TipIcon } from './tooltip';
import { money } from './format';
import styles from './row.module.css';

const DATE_FORMAT = 'DD/MM';
function fmt(d: Date) {
  return d.toISOString();
}

export function Row({ name, onDelete, size = DEFAULT_SIZE, at }: { name: string; onDelete: () => void; size?: string; at: Date }) {
  const [open, setOpen] = useState(false);
  const stamp = fmt(at);
  return (
    <li className={styles.row} data-size={size}>
      <span>{name}</span>
      <Badge>{money(1)}</Badge>
      <Button onClick={onDelete} className={styles.danger}>
        <Glyph name="trash" /> Delete {stamp} {open ? 'x' : ''}
        <Tooltip><TipIcon /></Tooltip>
      </Button>
      <button onClick={() => setOpen(!open)}>More</button>
    </li>
  );
}
`;

  it('takes out the imports and props only the removed element used, so the app still builds', () => {
    const out = removeElementTidy(ROW, locOf(ROW, '<Button onClick'));
    expect(out.code).not.toContain('Delete {stamp}');
    // Only it used Button, Glyph (an alias), Tooltip and TipIcon: they go; Badge and money stay, used elsewhere.
    expect(out.code).toContain("import { Badge } from './ds';");
    expect(out.code).not.toContain('tooltip');
    expect(out.code).toContain("import { money } from './format';");
    // Its prop goes from the component's arguments (still in the type: callers pass it as before).
    expect(out.code).toContain('export function Row({ name, size = DEFAULT_SIZE, at }: { name: string; onDelete: () => void; size?: string; at: Date })');
    expect(out.took).toEqual(['the Button import', 'the Glyph import', 'the Tooltip import', 'the TipIcon import', 'the onDelete prop']);
    // What only it read but may do more (a value worked out, a hook) stays, and is named.
    expect(out.unused).toEqual(['stamp']);
    expect(out.code).toContain('const stamp = fmt(at);');
    // styles is still used by the row.
    expect(out.code).toContain('import styles from');
    expect(() => findElement(out.code, locOf(out.code, '<li'))).not.toThrow();
  });

  it('leaves the props alone when the rest of them is passed on, and React in scope', () => {
    const code = `import React from 'react';
import { Icon } from './ds';

export function Chip({ label, icon, ...rest }: { label: string; icon: string }) {
  return (
    <span {...rest}>
      <Icon name={icon} />
      {label}
      <b>{React.version}</b>
    </span>
  );
}
`;
    const out = removeElementTidy(code, locOf(code, '<b>'));
    expect(out.code).toContain("import React from 'react';");
    expect(out.code).toContain('{ label, icon, ...rest }');
    expect(out.took).toEqual([]);
  });

  it('a name still used anywhere else (a default value, a type, an export) stays', () => {
    const code = `import { DEFAULT, Kind, Pill } from './ds';
export { Pill };

export function Tag({ kind = DEFAULT, extra }: { kind?: Kind; extra?: string }) {
  return (
    <div data-kind={kind}>
      <Pill kind={kind}>{extra}</Pill>
    </div>
  );
}
`;
    const out = removeElementTidy(code, locOf(code, '<Pill kind'));
    expect(out.code).toContain("import { DEFAULT, Kind, Pill } from './ds';");
    expect(out.code).toContain('{ kind = DEFAULT }:');
    expect(out.took).toEqual(['the extra prop']);
  });

  it('a prop that goes takes its default with it, and the import only that default used', () => {
    const code = `import { DEFAULT_TONE } from './tones';
import { Pill } from './ds';

export function Tag({ tone = DEFAULT_TONE }: { tone?: string }) {
  return (
    <div>
      <Pill tone={tone} />
      <span>Tag</span>
    </div>
  );
}
`;
    const out = removeElementTidy(code, locOf(code, '<Pill tone'));
    expect(out.took).toEqual(['the DEFAULT_TONE import', 'the Pill import', 'the tone prop']);
    expect(out.code).toContain('export function Tag(_props: { tone?: string })');
    expect(out.code).not.toContain('import');
  });
});

describe('componentAt', () => {
  it('names the component an element is part of, wrapped or not', () => {
    const code = `const Card = memo(function Inner({ title }: { title: string }) {
  return <h3>{title}</h3>;
});
export const Panel = forwardRef((props, ref) => <section ref={ref}><p>x</p></section>);
export default function Page() {
  return <main>{[1].map((n) => <i key={n}>{n}</i>)}</main>;
}
`;
    expect(componentAt(code, locOf(code, '<h3>'))).toBe('Card');
    expect(componentAt(code, locOf(code, '<p>x'))).toBe('Panel');
    expect(componentAt(code, locOf(code, '<i key'))).toBe('Page');
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
