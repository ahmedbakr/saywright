/** The diff and code views with syntax colours (prism): loaded the first time one is shown (see DiffView.tsx). */
import { Highlight, themes, type PrismTheme, type Token } from 'prism-react-renderer';
import { useEffect, useState, type ReactNode } from 'react';
import type { DiffFile, DiffLine } from '@shared/api';
import { cn } from '@/lib/cn';

const lang = (path: string) => (/\.(tsx|jsx)$/.test(path) ? 'tsx' : /\.ts$/.test(path) ? 'typescript' : /\.css$/.test(path) ? 'css' : /\.json$/.test(path) ? 'json' : 'tsx');
const isDark = () => document.documentElement.classList.contains('dark');

/** The syntax colours for the theme showing, followed as it changes (Settings, or the computer's own appearance). */
function useCodeTheme(): PrismTheme {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const watch = new MutationObserver(() => setDark(isDark()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, []);
  return dark ? DARK : LIGHT;
}

/** prism's GitHub and VS Code Dark colours, made to read at 4.5:1 or more on code, diff lines and changed words. */
function readable(theme: PrismTheme, fix: Record<string, string>): PrismTheme {
  return {
    ...theme,
    styles: theme.styles.map((entry) => {
      const { opacity: _faded, ...rest } = entry.style;
      return { ...entry, style: { ...rest, ...(rest.color ? { color: fix[rest.color] ?? rest.color } : {}) } };
    }),
  };
}
const LIGHT = readable(themes.github, { '#999988': '#55554a', '#e3116c': '#a8004f', '#36acaa': '#00625e', '#00a4db': '#005a8a', '#d73a49': '#a51d27', '#6f42c1': '#643ab0' });
const DARK = readable(themes.vsDark, {
  'rgb(0, 0, 128)': '#9da0a8',
  'rgb(106, 153, 85)': '#8ab872',
  'rgb(86, 156, 214)': '#7db8ea',
  'rgb(100, 102, 149)': '#a3a6dc',
  '#808080': '#a3a3a3',
  'rgb(209, 105, 105)': '#ec8f8f',
});
const BOUNDARY = /[\s"'`<>={}(),;]/;

/**
 * For each removed line followed by an added one, the part that actually
 * changed, widened to whole words, so a one-prop edit reads at a glance.
 */
function changedRanges(lines: DiffLine[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].type === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a].type === 'add') a++;
    if (d - i === a - d) {
      for (let k = 0; k < d - i; k++) {
        const x = lines[i + k].text;
        const y = lines[d + k].text;
        let p = 0;
        while (p < x.length && p < y.length && x[p] === y[p]) p++;
        let s = 0;
        while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
        while (p > 0 && !BOUNDARY.test(x[p - 1])) p--;
        let xe = x.length - s;
        let ye = y.length - s;
        while (xe < x.length && !BOUNDARY.test(x[xe])) xe++;
        while (ye < y.length && !BOUNDARY.test(y[ye])) ye++;
        // Highlight only real partial edits, not rewritten lines.
        if (Math.max(xe - p, ye - p) < Math.max(x.length, y.length) * 0.7) {
          if (xe > p) out.set(i + k, [p, xe]);
          if (ye > p) out.set(d + k, [p, ye]);
        }
      }
    }
    i = a;
  }
  return out;
}

/** Render syntax tokens, marking characters inside `range`. */
function renderTokens(tokens: Token[], getTokenProps: (o: { token: Token }) => { style?: { color?: string }; className?: string }, range: [number, number] | undefined, mark: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  tokens.forEach((t, k) => {
    const { style, className } = getTokenProps({ token: t });
    const text = t.content;
    const start = at;
    at += text.length;
    const parts: [string, boolean][] = [];
    if (!range || range[1] <= start || range[0] >= at) parts.push([text, false]);
    else {
      const a = Math.max(0, range[0] - start);
      const b = Math.min(text.length, range[1] - start);
      if (a > 0) parts.push([text.slice(0, a), false]);
      parts.push([text.slice(a, b), true]);
      if (b < text.length) parts.push([text.slice(b), false]);
    }
    for (const [j, [s, on]] of parts.entries())
      if (s)
        out.push(
          <span key={`${k}-${j}`} className={cn(className, on && mark)} style={{ color: style?.color }}>
            {s}
          </span>,
        );
  });
  return out;
}

/** A compact unified diff: syntax colours, wrapped lines, and the changed words marked. */
export function DiffView({ file }: { file: DiffFile }) {
  const theme = useCodeTheme();
  return (
    <div className="overflow-hidden rounded-[8px] bg-sunken ring-1 ring-inset ring-line">
      {file.hunks.map((h, hi) => {
        const ranges = changedRanges(h.lines);
        return (
          <div key={hi} className={cn('py-1', hi > 0 && 'border-t border-dashed border-line')}>
            {h.lines.map((l, i) => (
              <div
                key={i}
                className={cn('grid grid-cols-[30px_14px_1fr] font-mono text-[11.5px] leading-[18px]', l.type === 'add' && 'bg-ok-soft', l.type === 'del' && 'bg-bad-soft')}
              >
                <span className="select-none pr-1.5 text-right text-fg-3">{l.type === 'del' ? l.oldNo : l.newNo}</span>
                <span className={cn('select-none text-center', l.type === 'add' ? 'text-ok' : l.type === 'del' ? 'text-bad' : 'text-transparent')}>
                  {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                </span>
                <Highlight code={l.text || ' '} language={lang(file.path)} theme={theme}>
                  {({ tokens, getTokenProps }) => (
                    <span className="whitespace-pre-wrap break-all pr-2">
                      {renderTokens(tokens[0] ?? [], getTokenProps, ranges.get(i), l.type === 'add' ? 'rounded-[3px] bg-ok/12 underline decoration-ok/60 underline-offset-2' : 'rounded-[3px] bg-bad/12 underline decoration-bad/60 underline-offset-2')}
                    </span>
                  )}
                </Highlight>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function CodeBlock({ code, language = 'tsx', focus, start = 1 }: { code: string; language?: string; focus?: number; start?: number }) {
  const theme = useCodeTheme();
  return (
    <Highlight code={code.replace(/\n$/, '')} language={language} theme={theme}>
      {({ tokens, getLineProps, getTokenProps }) => (
        // Focusable, so the keyboard can scroll it too.
        <pre tabIndex={0} role="region" aria-label="Source code" className="overflow-x-auto rounded-[8px] bg-sunken py-2 font-mono text-[11.5px] leading-[19px] ring-1 ring-inset ring-line">
          {tokens.map((line, i) => {
            const n = start + i;
            const { style: _s, ...lineProps } = getLineProps({ line });
            return (
              <div key={i} {...lineProps} className={cn('grid grid-cols-[34px_1fr] pr-3', n === focus && 'bg-human-soft shadow-[inset_2px_0_0_var(--human)]')}>
                <span className="select-none pr-2.5 text-right text-fg-3">{n}</span>
                <span className="whitespace-pre">
                  {line.map((t, k) => {
                    const { style, ...rest } = getTokenProps({ token: t });
                    return <span key={k} {...rest} style={{ color: style?.color }} />;
                  })}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}
