import { parseSrc } from '@saywright/vite/protocol';
import type { InspectResult } from '../shared/api.ts';
import type { Project } from './project.ts';
import { elementName, findElement, readProps } from './quick/codemods.ts';

/** What the Inspector shows for a selected element: its JSX site, props and surrounding code. */
export function inspect(project: Project, src: string): InspectResult | null {
  const p = parseSrc(src);
  if (!p || !project.exists(p.file)) return null;
  const code = project.read(p.file);
  const lines = code.split('\n');
  let name = '';
  let props: InspectResult['props'] = [];
  let found = null;
  try {
    found = findElement(code, { line: p.line, col: p.col });
  } catch {
    found = null;
  }
  const spec = found ? project.componentSpec(elementName(found.el), p.file) : undefined;
  if (found) {
    name = elementName(found.el);
    const read = readProps(found.el);
    props = Object.entries(read)
      .filter(([k]) => !k.startsWith('data-ds-') && k !== 'key')
      .map(([k, v]) => ({
        name: k,
        value: v.kind === 'literal' ? v.value : v.kind === 'boolean' ? 'true' : '{…}',
        dynamic: v.kind === 'dynamic',
        options: spec?.props[k]?.values,
      }));
    // Show design-system props that are using their default too.
    for (const [k, d] of Object.entries(spec?.props ?? {})) {
      if (!props.some((x) => x.name === k) && d.default) props.push({ name: k, value: d.default, dynamic: false, options: d.values });
    }
    // Design-system props first, in the order the design system lists them, so editing doesn't reshuffle rows.
    const order = Object.keys(spec?.props ?? {});
    const rank = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
    props = props.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.name) - rank(b.p.name) || a.i - b.i).map((x) => x.p);
  }
  const start = Math.max(1, p.line - 4);
  const end = Math.min(lines.length, p.line + 8);
  return {
    name: name || 'element',
    file: p.file,
    line: p.line,
    col: p.col,
    absPath: project.resolve(p.file),
    props,
    snippet: { start, lines: lines.slice(start - 1, end), focus: p.line },
    designSystem: !!spec,
  };
}
