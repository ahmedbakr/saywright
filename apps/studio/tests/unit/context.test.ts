/**
 * What the person points at reaches AI apps over MCP, and the studio's own quick edits, with the place in the code
 * the Inspector shows: in Next.js apps too, whose folders are named like "(main)" and "[id]" and whose pages report
 * where they run in a bundle rather than where they were written.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanSrc, componentWrittenAt, sanitizeRefs } from '../../server/refs';
import { createStudioApi, studioRoutes, type Studio } from '../../server/index';
import { repoLayout } from '../../server/layout';
import { dispatch } from '../../server/standalone';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'src/app/(main)/users/[id]/page.tsx';

describe('a source location from the page', () => {
  it('may be any relative path in the project, Next.js route folders included', () => {
    expect(cleanSrc(`${PAGE}:4:7`)).toBe(`${PAGE}:4:7`);
    expect(cleanSrc('app/[locale]/(marketing)/my page.tsx:12:5')).toBe('app/[locale]/(marketing)/my page.tsx:12:5');
    expect(sanitizeRefs([{ src: `${PAGE}:4:7`, name: 'h1' }])[0].src).toBe(`${PAGE}:4:7`);
  });

  it('keeps what tells the element from its look-alikes, and where React said it came from, to trace it again', () => {
    const [ref] = sanitizeRefs([{ src: `${PAGE}:4:7`, name: 'a', hint: { attrs: { href: '/docs' } }, frames: [{ at: 'http://localhost:3000/_next/static/chunks/a.js:3:9', name: 'a', extra: 1 }] }]);
    expect(ref.hint).toEqual({ attrs: { href: '/docs' } });
    expect(ref.frames).toEqual([{ at: 'http://localhost:3000/_next/static/chunks/a.js:3:9', name: 'a' }]);
  });

  it('never leads anywhere odd: it steps out only at the start, to a monorepo’s other packages, which the project checks', () => {
    for (const bad of ['src/../../x.ts:1:1', '../src/../x.ts:1:1', '..:1:1', '/etc/passwd:1:1', 'C:/Users/x.ts:1:1', 'https://example.com/a.js:1:1', 'src/a.ts?x=1:1:1', 'src\\a.ts:1:1', 'src//a.ts:1:1', 'src/a.ts:0:1', 'src/a.ts', 'src/a\u0000.ts:1:1']) {
      expect(cleanSrc(bad), bad).toBeNull();
    }
    expect(cleanSrc('../../packages/ui/Button.tsx:3:5')).toBe('../../packages/ui/Button.tsx:3:5');
  });

  it('names an element by the component written where it is used (its outermost element), as the Inspector does', () => {
    const code = 'export const Row = () => (\n  <li>\n    <Badge tone="vip">VIP</Badge> <UI.Chip /> <span>x</span>\n  </li>\n);\n';
    const read = (file: string) => (file === 'src/Row.tsx' ? code : '');
    expect(componentWrittenAt(read, 'src/Row.tsx:3:5')).toBe('Badge');
    expect(componentWrittenAt(read, 'src/Row.tsx:3:35')).toBe('UI.Chip');
    expect(componentWrittenAt(read, 'src/Row.tsx:3:47')).toBeNull();
    expect(componentWrittenAt(read, 'src/Row.tsx:2:3')).toBeNull();
    expect(componentWrittenAt(read, 'src/Row.tsx:40:3')).toBeNull();
    expect(componentWrittenAt(() => { throw new Error('gone'); }, 'src/Row.tsx:3:5')).toBeNull();
  });
});

describe('a Next.js page, pointed at in the studio', () => {
  const saved = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-next-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-next-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('package.json', '{"name":"next-admin","dependencies":{"next":"16.0.0"}}');
  write(PAGE, 'export default function Page() {\n  return (\n    <main>\n      <h1>Hello again</h1>\n    </main>\n  );\n}\n');
  // A component whose outermost element is its <span>: pointed at, it is where the component is used.
  const TAGS = 'src/app/tags/page.tsx';
  write(TAGS, 'import { Badge } from "../../Badge";\nexport default function Tags() {\n  return (\n    <p>\n      <Badge tone="vip">VIP</Badge>\n    </p>\n  );\n}\n');
  write('src/Badge.tsx', 'export function Badge({ tone, children }) {\n  return <span className={tone}>{children}</span>;\n}\n');
  // The bundle the page runs from, with its source map: column 5 of line 1 is the <h1> at line 4, column 7.
  const chunk = '.next/server/chunks/ssr/[root-of-the-server]__0abc._.js';
  write(chunk, 'var x=jsx("h1",{children:"Hello again"});\n//# sourceMappingURL=[root-of-the-server]__0abc._.js.map\n');
  write(`${chunk}.map`, JSON.stringify({ version: 3, sources: [`webpack://_N_E/./${PAGE}`], names: [], mappings: 'IAGM' }));
  const bundleSrc = `${path.join(root, chunk)}?20:1:5`;

  let app: http.Server;
  let studio: Studio;
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    // The running app (its plugin answers, so the studio doesn't put its proxy in front).
    app = http.createServer((req, res) => {
      if (req.url === '/__saywright/info') return res.setHeader('Content-Type', 'application/json'), res.end(JSON.stringify({ root }));
      res.end('ok');
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { SAYWRIGHT_HOME: home, SAYWRIGHT_AI: 'fake', SAYWRIGHT_TARGET_URL: `http://localhost:${(app.address() as AddressInfo).port}/`, SAYWRIGHT_TARGET_ROOT: root });
    const layout = { ...repoLayout(path.resolve(here, '../../../..')), envDir: home };
    studio = await createStudioApi(layout);
    server = http.createServer(dispatch(studioRoutes(studio, layout)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    studio?.close();
    server?.closeAllConnections();
    app?.closeAllConnections();
    await Promise.all([new Promise((r) => server?.close(r)), new Promise((r) => app?.close(r))]);
    for (const k of ['SAYWRIGHT_HOME', 'SAYWRIGHT_AI', 'SAYWRIGHT_TARGET_URL', 'SAYWRIGHT_TARGET_ROOT']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const json = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };

  it('reaches an AI app over MCP with the place the Inspector shows', async () => {
    const inspected = await json('GET', `/inspect?src=${encodeURIComponent(bundleSrc)}`);
    expect(inspected.result).toMatchObject({ file: PAGE, line: 4, col: 7, name: 'h1' });

    await json('PUT', '/context', { pageUrl: 'http://localhost:3000/users/7', selection: [{ role: 'selection', src: bundleSrc, name: 'h1', label: '', text: 'Hello again', tag: 'h1' }], pins: [] });
    const { mcp } = await json('GET', '/ai');
    const call = await json('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } }, { authorization: `Bearer ${mcp.token}`, accept: 'application/json, text/event-stream' });
    const text = call.result.content[0].text as string;
    expect(text).toContain(`1. selected: h1 showing “Hello again” at ${PAGE}:4:7`);
    expect(text).toContain('   4>       <h1>Hello again</h1>');
  });

  it('names what is selected once, though it is pinned too, and the person’s last words with when', async () => {
    const h1 = { role: 'selection', src: bundleSrc, name: 'h1', label: '', text: 'Hello again', tag: 'h1' };
    await json('PUT', '/context', { pageUrl: 'http://localhost:3000/users/7', selection: [h1], pins: [{ ...h1, role: 'pin' }], said: 'make this bigger' });
    const { mcp } = await json('GET', '/ai');
    const call = await json('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_context', arguments: {} } }, { authorization: `Bearer ${mcp.token}`, accept: 'application/json, text/event-stream' });
    const text = call.result.content[0].text as string;
    expect(text).toContain('1. selected: h1');
    expect(text).not.toContain('2. pinned');
    expect(text).toMatch(/Last said in the studio \(\d+ s ago\): “make this bigger”/);
  });

  it('names an element pointed at where its component is used by the component, as the Inspector does', async () => {
    const r = await json('POST', '/intent', { text: 'remove this', refs: [{ role: 'this', src: `${TAGS}:5:7`, name: 'span', label: 'span · VIP', text: 'VIP', tag: 'span' }] });
    expect(r.kind).toBe('change');
    expect(r.change.title).toMatch(/^Remove “VIP” Badge/);
    expect(r.change.refs[0]).toMatchObject({ name: 'Badge', label: 'Badge · VIP' });
    await json('POST', '/changes/undo', { id: r.change.id });
  });

  it('takes a quick edit at that place', async () => {
    const r = await json('POST', '/intent', { text: 'rename this to Welcome back', refs: [{ role: 'this', src: `${PAGE}:4:7`, name: 'h1', label: '', text: 'Hello again', tag: 'h1' }] });
    expect(r.kind).toBe('change');
    expect(fs.readFileSync(path.join(root, PAGE), 'utf8')).toContain('<h1>Welcome back</h1>');
  });
});
