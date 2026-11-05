/**
 * An app in a monorepo (apps/web next to packages/ui): the elements it takes from a sibling package are traced there,
 * and quick edits, the AI's read_file and AI apps over MCP read and change that code, while anything outside the
 * workspace, or a link leading out of it, is still refused.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileTool } from '../../server/ai/tools';
import { createStudioApi, studioRoutes, type Studio } from '../../server/index';
import { repoLayout } from '../../server/layout';
import { Project } from '../../server/project';
import { dispatch } from '../../server/standalone';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUTTON = '../../packages/ui/src/Button.tsx';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-monorepo-'));
const ws = path.join(base, 'acme');
const web = path.join(ws, 'apps/web');
const write = (abs: string, text: string) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
write(path.join(ws, 'package.json'), JSON.stringify({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'] }));
write(path.join(web, 'package.json'), JSON.stringify({ name: 'web' }));
write(path.join(web, 'src/App.tsx'), "import { Button } from '@acme/ui';\nexport const App = () => <main><Button /></main>;\n");
write(path.join(ws, 'packages/ui/package.json'), JSON.stringify({ name: '@acme/ui' }));
write(path.join(ws, 'packages/ui/src/Button.tsx'), 'export function Button() {\n  return <button className="btn">Save</button>;\n}\n');
write(path.join(base, 'outside.txt'), 'not the app’s\n');
fs.symlinkSync(path.join(base, 'outside.txt'), path.join(ws, 'packages/ui/src/leak.tsx'));

describe('the code of an app in a monorepo', () => {
  const project = new Project(web, 'http://localhost:5300', undefined, true);

  it('includes its sibling packages: the AI’s read_file reads them', () => {
    expect(readFileTool(project, BUTTON)).toContain('2    return <button className="btn">Save</button>;');
  });

  it('searches and lists its sibling packages too, by the paths read_file takes, and never what a link leads to', async () => {
    const found = await project.search('className="btn"');
    expect(found.hits).toEqual([{ path: BUTTON, line: 2, text: 'return <button className="btn">Save</button>;' }]);
    expect((await project.search('Save', { dir: '../../packages/ui' })).hits.map((h) => h.path)).toEqual([BUTTON]);
    expect((await project.search('not the app')).hits).toEqual([]);
    const files = project.listFiles();
    expect(files.indexOf('src/App.tsx')).toBeLessThan(files.indexOf(BUTTON));
    expect(files).toContain('../../packages/ui/package.json');
    expect(files).not.toContain('../../packages/ui/src/leak.tsx');
    expect(files.filter((f) => f.endsWith('App.tsx'))).toEqual(['src/App.tsx']);
  });

  it('stops at the workspace: a path outside it, or a link leading out of it, is refused', () => {
    expect(() => readFileTool(project, '../../../outside.txt')).toThrow(/outside the project/);
    expect(() => readFileTool(project, '../../packages/ui/src/leak.tsx')).toThrow(/outside the project/);
    expect(() => project.write('../../../elsewhere.txt', 'x')).toThrow(/outside the project/);
    expect(fs.existsSync(path.join(base, 'elsewhere.txt'))).toBe(false);
  });

  it('is only its own folder when it is in no workspace', () => {
    write(path.join(base, 'solo/package.json'), '{}');
    const solo = new Project(path.join(base, 'solo'), 'http://localhost:5301', undefined, true);
    expect(solo.read('package.json')).toBe('{}');
    expect(() => solo.read('../outside.txt')).toThrow(/outside the project/);
  });
});

describe('an element from a sibling package, pointed at in the studio', () => {
  const saved = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-monorepo-home-'));
  let app: http.Server;
  let studio: Studio;
  let server: http.Server;
  let api = '';
  beforeAll(async () => {
    // The running app (its plugin answers, so the studio doesn't put its proxy in front).
    app = http.createServer((req, res) => {
      if (req.url === '/__saywright/info') return res.setHeader('Content-Type', 'application/json'), res.end(JSON.stringify({ root: web }));
      res.end('ok');
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { SAYWRIGHT_HOME: home, SAYWRIGHT_AI: 'fake', SAYWRIGHT_TARGET_URL: `http://localhost:${(app.address() as AddressInfo).port}/`, SAYWRIGHT_TARGET_ROOT: web });
    const layout = { ...repoLayout(path.resolve(here, '../../../..')), envDir: home };
    studio = await createStudioApi(layout);
    server = http.createServer(dispatch(studioRoutes(studio, layout)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
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
    const res = await fetch(api + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  };
  const button = { role: 'this', src: `${BUTTON}:2:10`, name: 'button', label: 'Save', text: 'Save', tag: 'button' };

  it('opens in the Inspector, and reaches an AI app over MCP with its place and code', async () => {
    const inspected = await json('POST', '/inspect', { ref: button });
    expect(inspected.result).toMatchObject({ file: BUTTON, line: 2, col: 10 });

    await json('PUT', '/context', { pageUrl: 'http://localhost:5173/', selection: [{ ...button, role: 'selection' }], pins: [] });
    const { mcp } = await json('GET', '/ai');
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await json('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${mcp.token}`, accept: 'application/json, text/event-stream' });
      return r.result.content[0].text as string;
    };
    const context = await call('get_context', {});
    expect(context).toContain(`1. selected: Save showing “Save” at ${BUTTON}:2:10`);
    expect(await call('read_file', { path: BUTTON })).toContain('<button className="btn">Save</button>');
    expect(await call('read_file', { path: '../../../outside.txt' })).toMatch(/outside the project/);
  });

  it('takes a quick edit there', async () => {
    const r = await json('POST', '/intent', { text: 'rename this to Keep', refs: [button] });
    expect(r.kind).toBe('change');
    expect(fs.readFileSync(path.join(ws, 'packages/ui/src/Button.tsx'), 'utf8')).toContain('<button className="btn">Keep</button>');
  });
});
