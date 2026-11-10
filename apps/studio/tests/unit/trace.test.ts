import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceFrame } from '@saywright/vite/protocol';
import { Project } from '../../server/project';
import type { SourceMapper } from '../../server/sessions/sourcemap';
import { Tracer, frameList } from '../../server/trace';

function app(files: Record<string, string>, root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-trace-'))): Project {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return new Project(root, 'http://localhost:5300', undefined, true);
}

/** Bundle positions as a dev server's source maps would map them. */
function mapper(map: Record<string, string>): SourceMapper {
  return { map: async (at: string) => map[at] ?? null, mapEval: async () => null } as unknown as SourceMapper;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n: number) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v) d |= 32;
    out += B64[d];
  } while (v);
  return out;
};

const trace = (p: Project, map: Record<string, string>, frames: SourceFrame[], el: { tag?: string; text?: string; hint?: unknown } = {}) =>
  new Tracer(p, mapper(map)).trace({ src: frames[0]?.inside ? null : (frames[0]?.at ?? null), frames, ...el });

describe('tracing an element from what React says about it', () => {
  it('takes its own JSX when that is the app’s code', async () => {
    const p = app({ 'src/page.tsx': 'export default () => <h1>Hello</h1>;\n' });
    expect(await trace(p, { 'chunk.js:1:9': 'src/page.tsx:1:22' }, [{ at: 'chunk.js:1:9', name: 'h1' }], { tag: 'h1' })).toEqual({ src: 'src/page.tsx:1:22', guessed: false });
  });

  it('skips frames in libraries (a <Link>’s own <a>) and takes where the component was used', async () => {
    const p = app({ 'src/nav.tsx': 'export const Nav = () => <Link href="/crm">CRM</Link>;\n' });
    const map = { 'link.js:454:50': 'node_modules/next/dist/client/app-dir/link.js:310:5', 'chunk.js:20:7': 'src/nav.tsx:1:27' };
    const frames = [
      { at: 'link.js:454:50', name: 'a' },
      { at: 'chunk.js:20:7', name: 'LinkComponent', root: true },
    ];
    expect(await trace(p, map, frames, { tag: 'a' })).toEqual({ src: 'src/nav.tsx:1:27', guessed: false });
  });

  it('goes on to where each component that passes the element its props was used, like the plugin’s instance sites', async () => {
    const p = app({});
    const map = { 'c.js:1:1': 'src/components/ui/button.tsx:56:5', 'c.js:2:2': 'src/login-form.tsx:40:9', 'c.js:3:3': 'src/page.tsx:10:5' };
    const frames = [
      { at: 'c.js:1:1', name: 'button' },
      { at: 'c.js:2:2', name: 'Button', root: true },
      { at: 'c.js:3:3', name: 'LoginForm' },
    ];
    expect((await trace(p, map, frames, { tag: 'button' })).src).toBe('src/login-form.tsx:40:9');
  });

  it('takes where the component is used in its own file too, and stays where a component that doesn’t pass its props is', async () => {
    const p = app({});
    const map = { 'c.js:1:1': 'src/page.tsx:3:5', 'c.js:2:2': 'src/page.tsx:12:7' };
    expect((await trace(p, map, [{ at: 'c.js:1:1', name: 'li' }, { at: 'c.js:2:2', name: 'Row', root: true }], { tag: 'li' })).src).toBe('src/page.tsx:12:7');
    expect((await trace(p, map, [{ at: 'c.js:1:1', name: 'li' }, { at: 'c.js:2:2', name: 'Row' }], { tag: 'li' })).src).toBe('src/page.tsx:3:5');
  });

  it('doesn’t jump to where a far-away component was used', async () => {
    const p = app({});
    const map = { 'c.js:1:1': 'node_modules/theme/Navbar.js:1:1', 'c.js:2:2': 'node_modules/theme/Layout.js:1:1', 'c.js:3:3': 'src/pages/index.js:30:5' };
    const frames = [
      { at: 'c.js:1:1', name: 'a' },
      { at: 'c.js:2:2', name: 'NavbarItem' },
      { at: 'c.js:3:3', name: 'Layout' },
    ];
    expect(await trace(p, map, frames, { tag: 'a' })).toEqual({ src: null, guessed: false });
  });

  it('React 19.0: finds the element inside the component that wrote it, then where that component was used', async () => {
    const p = app({
      'src/IconButton.tsx': 'export function IconButton(props) {\n  const { title } = props;\n  return <button className="ToolIcon" title={title} />;\n}\n',
      'src/Toolbar.tsx': 'export function Toolbar() {\n  const [on] = useState(false);\n  return <div><IconButton title="Lock" /></div>;\n}\n',
    });
    const map = { 'http://x/src/IconButton.tsx:2:11': 'src/IconButton.tsx:2:11', 'http://x/src/Toolbar.tsx:2:16': 'src/Toolbar.tsx:2:16' };
    const own: SourceFrame = { at: 'http://x/src/IconButton.tsx:2:11', name: 'button', inside: true };
    const use: SourceFrame = { at: 'http://x/src/Toolbar.tsx:2:16', name: 'IconButton', inside: true };
    expect(await trace(p, map, [own, use], { tag: 'button' })).toEqual({ src: 'src/IconButton.tsx:3:10', guessed: false });
    expect(await trace(p, map, [own, { ...use, root: true }], { tag: 'button' })).toEqual({ src: 'src/Toolbar.tsx:3:15', guessed: false });
  });

  it('React 19.0: a component it couldn’t place is found from where it is used, by what the page shows', async () => {
    const p = app({
      'src/Help.tsx': 'const Header = () => (\n  <div>\n    <a href="https://docs.example.com">Docs</a>\n    <a href="https://blog.example.com">Blog</a>\n  </div>\n);\nexport function Help() {\n  const x = useX();\n  return <Header />;\n}\n',
    });
    const map = { 'http://x/src/Help.tsx:8:13': 'src/Help.tsx:8:13' };
    const frames = [{ at: 'http://x/src/Help.tsx:8:13', name: 'Header', inside: true }];
    expect(await trace(p, map, frames, { tag: 'a', text: 'Blog', hint: { attrs: { href: 'https://blog.example.com' } } })).toEqual({ src: 'src/Help.tsx:4:5', guessed: false });
  });

  it('webpack’s eval’d modules: the file is right, the line is found in it', async () => {
    const p = app({ 'src/pages/index.js': 'import Heading from "@theme/Heading";\n\nfunction Header() {\n  return (\n    <header>\n      <Heading as="h1">Title</Heading>\n    </header>\n  );\n}\n' });
    const frames = [{ at: 'webpack-internal:///./src/pages/index.js:28:80', name: 'Heading', root: true }];
    expect(await trace(p, {}, frames, { tag: 'h1' })).toEqual({ src: 'src/pages/index.js:6:7', guessed: false });
  });

  it('webpack’s eval’d modules written to disk (Next.js): through the module’s own source map', async () => {
    // Compiled line 3, column 5 of the module is line 10, column 3 of the file.
    const map = { version: 3, sources: ['webpack://_N_E/./src/app/(main)/page.tsx?3a1f'], names: [], mappings: `;;${vlq(4)}${vlq(0)}${vlq(9)}${vlq(2)}` };
    const url = 'webpack-internal:///(app-pages-browser)/./src/app/(main)/page.tsx';
    const code = `"use strict";\\nconst a = 1;\\n    jsx("h1")\\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\\n//# sourceURL=${url}\\n`;
    const p = app({
      'src/app/(main)/page.tsx': 'export default function Page() {\n  return <h1>Hi</h1>;\n}\n',
      '.next/dev/static/chunks/app/page.js': `(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([["app/page"], {\n"(app-pages-browser)/./src/app/(main)/page.tsx": (function(module) {\neval(__webpack_require__.ts("${code}"));\n})}]);\n`,
    });
    const { SourceMapper } = await import('../../server/sessions/sourcemap');
    expect(await new SourceMapper(p).mapEval(`${url}:3:5`)).toBe('src/app/(main)/page.tsx:10:3');
    expect(await new SourceMapper(p).mapEval('webpack-internal:///./src/elsewhere.tsx:3:5')).toBeNull();
  });

  it('a place found by searching the code is a guess, and says so', async () => {
    const p = app({ 'index.html': '<main>\n  <button class="save">Save draft</button>\n</main>\n' });
    expect(await new Tracer(p, null).trace({ src: null, tag: 'button', text: 'Save draft', hint: { attrs: { class: 'save' } } })).toEqual({ src: 'index.html:2:3', guessed: true });
  });

  it('a sibling package of the workspace is the app’s code; a library’s is not', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-ws-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
    const p = app({ 'package.json': '{}' }, path.join(root, 'apps/web'));
    app({ 'packages/ui/package.json': '{}', 'packages/ui/Button.tsx': 'export const Button = () => <button />;\n' }, root);
    const t = new Tracer(p, mapper({ 'http://x/@fs/b.tsx:1:1': '../../packages/ui/Button.tsx:1:30', 'http://x/n.js:1:1': '../../node_modules/ui/b.js:1:1' }));
    expect(await t.toSource('http://x/@fs/b.tsx:1:1')).toBe('../../packages/ui/Button.tsx:1:30');
    expect(await t.toSource('http://x/n.js:1:1')).toBeNull();
    expect(p.read('../../packages/ui/Button.tsx')).toContain('<button />');
    expect(() => p.read('../../package.json')).not.toThrow();
    expect(() => p.read('../../../outside.txt')).toThrow(/outside the project/);
  });
});

describe('a guess, as the AI is told it', () => {
  it('says the place was found by searching the code', async () => {
    const { systemPrompt, userMessage } = await import('../../server/ai/context');
    const p = app({ 'src/Note.tsx': 'export const Note = () => <button>Add a note</button>;\n' });
    const ref = { role: 'this', name: 'button', label: 'Add a note', text: 'Add a note', src: 'src/Note.tsx:1:27' };
    const msg = userMessage({ text: 'Make it blue', refs: [{ ...ref, guessed: true }, { ...ref, role: 'that' }], mode: 'edit' }, p);
    expect(msg).toContain('1. this → button showing “Add a note” at src/Note.tsx:1:27 (a guess, found by searching the code for its text)');
    expect(msg).toContain('2. that → button showing “Add a note” at src/Note.tsx:1:27\n');
    expect(systemPrompt(p)).toContain('A location marked as a guess was found by searching the code');
  });
});

describe('frames a page sends', () => {
  it('are checked: positions with what is written there, at most ten', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ at: `c.js:${i}:1`, name: 'div', root: true, extra: 'x' }));
    expect(frameList(many)).toHaveLength(10);
    expect(frameList([{ at: 'c.js:1:1', name: 'not a name!', inside: 'yes' }, { at: 42 }, null])).toEqual([{ at: 'c.js:1:1' }]);
    expect(frameList('nope')).toEqual([]);
  });
});

describe('an element written in a Next.js server layout (Turbopack)', () => {
  const LAYOUT = `import Link from 'next/link';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="nav">
          <Link className="logo" href="/">Studio North</Link>
          <nav>
            <Link href="/about">Team</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
`;
  /** Where Turbopack's server chunk says the layout's code is: the module named in the chunk's address. */
  const at = (root: string, pos: string) => `${root}/.next/dev/server/chunks/ssr/_1sgonsqcyuuh3._.js?id=%5Bproject%5D/app/layout.tsx+%5Bapp-rsc%5D+(ecmascript)?0:${pos}`;

  it('is mapped through the chunk’s source map when there is one', async () => {
    const p = app({ 'app/layout.tsx': LAYOUT });
    const chunk = `${p.root}/.next/dev/server/chunks/ssr/_1sgonsqcyuuh3._.js`;
    const out = await trace(p, { [`${chunk}:27:276`]: 'app/layout.tsx:8:11' }, [{ at: at(p.root, '27:276'), name: 'LinkComponent', root: true }], { tag: 'a', text: 'Studio North' });
    expect(out).toEqual({ src: 'app/layout.tsx:8:11', guessed: false });
  });

  it('without one, is found in the layout the chunk names, and said to be a guess', async () => {
    const p = app({ 'app/layout.tsx': LAYOUT, 'app/page.tsx': 'export default function Page() { return <h1>Home</h1>; }\n' });
    const out = await trace(p, {}, [{ at: at(p.root, '46:284'), name: 'LinkComponent', root: true }], { tag: 'a', text: 'Team' });
    expect(out).toEqual({ src: 'app/layout.tsx:10:13', guessed: true });
  });
});
