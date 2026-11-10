import { describe, expect, it } from 'vitest';
import { CodemodError, componentAt, ComputedTextError, MixedTextError, moveElement, readProps, findElement, removeElement, removeElementTidy, setProp, setText } from '../../server/quick/codemods';
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

describe('setProp where a line or a spread matters', () => {
  it('a new prop goes before props spread last, so what the caller passes still wins', () => {
    const one = '<div>\n  <Button {...props}>Got it</Button>\n</div>';
    expect(setProp(one, locOf(one, '<Button'), 'size', 'lg')).toContain('<Button size="lg" {...props}>Got it</Button>');
    const many = '<div>\n  <Button\n    onClick={go}\n    {...props}\n  >\n    Go\n  </Button>\n</div>';
    expect(setProp(many, locOf(many, '<Button'), 'size', 'lg')).toContain('    onClick={go}\n    size="lg"\n    {...props}\n');
  });

  it('a prop on a line of its own ends in CRLF in a CRLF file', () => {
    const code = '<div>\r\n\t<Button\r\n\t\tonClick={go}\r\n\t>\r\n\t\tGo\r\n\t</Button>\r\n</div>';
    const out = setProp(code, locOf(code, '<Button'), 'size', 'lg');
    expect(out).toContain('\t\tonClick={go}\r\n\t\tsize="lg"\r\n\t>');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
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

  it('changes the words beside an input or an icon, and only when they are all it shows', () => {
    const form = `export function F() {
  return (
    <form>
      <label className="row">
        Email <input type="email" name="email" />
      </label>
      <label><input type="checkbox" /> Remember me</label>
      <button><svg viewBox="0 0 8 8"><path d="M0 0h8v8H0z" /></svg> Save</button>
      <p>Total: <Price value={total} /></p>
      <p>Hello <b>world</b></p>
    </form>
  );
}
`;
    expect(setText(form, locOf(form, '<label className'), 'Work email', 'children', undefined, 'Email')).toContain('        Work email <input type="email" name="email" />');
    expect(setText(form, locOf(form, '<label><input'), 'Keep me signed in', 'children', undefined, 'Remember me')).toContain('<label><input type="checkbox" /> Keep me signed in</label>');
    expect(setText(form, locOf(form, '<button>'), 'Save draft')).toContain('</svg> Save draft</button>');
    // The page shows more than the words written here (the price): which part was meant can't be told.
    expect(() => setText(form, locOf(form, '<p>Total'), 'Sum:', 'children', undefined, 'Total: $5.00')).toThrow(ComputedTextError);
    // Words split around other words.
    expect(() => setText(form, locOf(form, '<p>Hello'), 'Hi there', 'children', undefined, 'Hello world')).toThrow(MixedTextError);
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

describe('removing one side of an expression', () => {
  const PANEL = `import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';
import { Open, Closed } from './state';

export function Panel({ title, children, open }: { title?: string; children?: React.ReactNode; open: boolean }) {
  return (
    <section>
      {title ?? <Skeleton />}
      {children || (
        <EmptyState />
      )}
      {open ? <Open /> : <Closed />}
      {open ? (
        <Open />
      ) : null}
    </section>
  );
}
`;
  it('removing a fallback leaves what shows the rest of the time, and its prop', () => {
    const a = removeElementTidy(PANEL, locOf(PANEL, '<Skeleton'));
    expect(a.code).toContain('      {title}\n');
    expect(a.code).toContain('export function Panel({ title, children, open }');
    expect(a.code).not.toContain('Skeleton');
    expect(a.took).toEqual(['the Skeleton import']);
    const b = removeElementTidy(PANEL, locOf(PANEL, '<EmptyState'));
    expect(b.code).toContain('      {children}\n      {open ?');
    expect(b.code).toContain('export function Panel({ title, children, open }');
    expect(b.code).not.toContain('EmptyState');
  });

  it('removing one branch of a condition leaves null in its place, and the other branch and its import', () => {
    const a = removeElementTidy(PANEL, locOf(PANEL, '<Closed'));
    expect(a.code).toContain('{open ? <Open /> : null}');
    expect(a.code).toContain("import { Open } from './state';");
    const b = removeElementTidy(PANEL, locOf(PANEL, '<Open />'));
    expect(b.code).toContain('{open ? null : <Closed />}');
    expect(b.code).toContain("import { Open, Closed } from './state';");
    const c = removeElementTidy(PANEL, locOf(PANEL, '<Open />\n'));
    expect(c.code).toContain('{open ? null : null}');
    expect(c.code).toContain("import { Open, Closed } from './state';");
    expect(c.code).toContain('open }: {');
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
  it('takes the comment written above an element with it', () => {
    const code = '<ul>\n  {/* the first */}\n  <li>A</li>\n  {/*\n    the second\n  */}\n  <li>B</li>\n  <li>C</li>\n</ul>';
    expect(moveElement(code, locOf(code, '<li>A'), locOf(code, '<li>C'), 'below')).toBe('<ul>\n  {/*\n    the second\n  */}\n  <li>B</li>\n  <li>C</li>\n  {/* the first */}\n  <li>A</li>\n</ul>');
    expect(moveElement(code, locOf(code, '<li>B'), locOf(code, '<li>A'), 'above')).toBe('<ul>\n  {/*\n    the second\n  */}\n  <li>B</li>\n  {/* the first */}\n  <li>A</li>\n  <li>C</li>\n</ul>');
  });

  it('moves an element above a sibling', () => {
    const out = moveElement(SRC, locOf(SRC, '<p>Second'), locOf(SRC, '<p>First'), 'above');
    expect(out.indexOf('Second')).toBeLessThan(out.indexOf('First'));
  });

  it('is a no-op when already in place', () => {
    expect(moveElement(SRC, locOf(SRC, '<p>First'), locOf(SRC, '<p>Second'), 'above')).toBe(SRC);
  });
});
