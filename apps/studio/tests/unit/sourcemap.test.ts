/**
 * Following source maps back to the app's code never leads the studio anywhere else. The positions it is given come
 * from the page being tested (an element's source, an error's stack), and that page can be any site: it must not be
 * able to make the studio's server call other servers, or read files outside the app's folder.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Project } from '../../server/project';
import { SourceMapper } from '../../server/sessions/sourcemap';
import { tree } from './helpers';

/** A source map saying that all of the generated file is `source`, line for line. */
const mapOf = (source: string) => JSON.stringify({ version: 3, sources: [source], names: [], mappings: 'AAAA;AACA;AACA' });
const inline = (source: string) => `console.log(1);\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(mapOf(source)).toString('base64')}\n`;

interface Served {
  url: string;
  port: number;
  asked: string[];
  close: () => Promise<void>;
}

/** A server that notes what it is asked for. `answer` gives a path's body, or a redirect. */
async function serve(answer: (path: string) => string | { to: string } | null): Promise<Served> {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    const body = answer(req.url ?? '');
    if (body && typeof body === 'object') {
      res.writeHead(302, { Location: body.to });
      return res.end();
    }
    res.statusCode = body === null ? 404 : 200;
    res.end(body ?? 'Not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, asked, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

let app: Served;
let other: Served;
let root: string;
beforeAll(async () => {
  root = tree({ 'package.json': { name: 'shop' }, 'src/App.tsx': 'export const App = () => null;\n', 'dist/chunk.js': 'console.log(1);\n', 'dist/chunk.js.map': mapOf('../src/App.tsx') });
  other = await serve(() => inline('src/App.tsx'));
  app = await serve((p) => (p === '/src/App.tsx' ? inline('App.tsx') : p === '/assets/moved.js' ? { to: `${other.url}/internal` } : p === '/assets/far.js' ? `console.log(1);\n//# sourceMappingURL=${other.url}/far.js.map\n` : null));
});
afterAll(async () => {
  await app.close();
  await other.close();
});

describe('source maps are followed only at the app’s own address', () => {
  it('maps a place in the app’s served code to its source', async () => {
    const mapper = new SourceMapper(new Project(root, app.url));
    expect(await mapper.map(`${app.url}/src/App.tsx:1:1`)).toBe('src/App.tsx:1:1');
    // The same computer by its other name is the same app.
    expect(await new SourceMapper(new Project(root, `http://localhost:${app.port}`)).map(`${app.url}/src/App.tsx:2:1`)).toBe('src/App.tsx:2:1');
  });

  it('asks nothing of any other server, whatever the page says its code is at', async () => {
    const mapper = new SourceMapper(new Project(root, app.url));
    other.asked.length = 0;
    expect(await mapper.map(`${other.url}/latest/meta-data/credentials:12:5`)).toBeNull();
    expect(await mapper.mapStack(`Error: x\n    at f (${other.url}/internal-admin:1:1)\n    at g (http://169.254.169.254/latest/meta-data:1:1)`)).toContain(`${other.url}/internal-admin:1:1`);
    expect(other.asked).toEqual([]);
  });

  it('takes the studio’s proxy in front of the app for the app, and nothing else on this computer', async () => {
    const project = new Project(root, 'http://localhost:1');
    project.frame = app.url;
    const mapper = new SourceMapper(project);
    expect(await mapper.map(`${app.url}/src/App.tsx:1:1`)).toBe('src/App.tsx:1:1');
    other.asked.length = 0;
    expect(await mapper.map(`${other.url}/x.js:1:1`)).toBeNull();
    expect(other.asked).toEqual([]);
  });

  it('doesn’t follow the app’s code where it points outside the app: a redirect, a map kept elsewhere', async () => {
    const mapper = new SourceMapper(new Project(root, app.url));
    other.asked.length = 0;
    expect(await mapper.map(`${app.url}/assets/moved.js:1:1`)).toBeNull();
    expect(await mapper.map(`${app.url}/assets/far.js:1:1`)).toBeNull();
    expect(other.asked).toEqual([]);
  });
});

describe('source maps are read only in the app’s folder', () => {
  it('maps a built file of the app through the map beside it', async () => {
    expect(await new SourceMapper(new Project(root, app.url)).map(`${path.join(root, 'dist/chunk.js')}:2:1`)).toBe('src/App.tsx:2:1');
  });

  it('reads no file elsewhere on the disk, by its path, a file:// address or a link from inside the app', async () => {
    // A file outside the app whose map names a file of the app: read, it would map.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-outside-'));
    fs.writeFileSync(path.join(outside, 'planted.js'), inline(path.join(root, 'src/App.tsx')));
    const mapper = new SourceMapper(new Project(root, app.url));
    expect(await mapper.map(`${path.join(outside, 'planted.js')}:1:1`)).toBeNull();
    expect(await mapper.map(`file://${path.join(outside, 'planted.js')}:1:1`)).toBeNull();
    expect(await mapper.mapStack(`at f (${path.join(outside, 'planted.js')}:1:1)`)).toBe(`at f (${path.join(outside, 'planted.js')}:1:1)`);
    fs.symlinkSync(path.join(outside, 'planted.js'), path.join(root, 'dist/linked.js'));
    expect(await mapper.map(`${path.join(root, 'dist/linked.js')}:1:1`)).toBeNull();
    // The same file inside the app is the app's own.
    fs.copyFileSync(path.join(outside, 'planted.js'), path.join(root, 'dist/own.js'));
    expect(await mapper.map(`${path.join(root, 'dist/own.js')}:1:1`)).toBe('src/App.tsx:1:1');
  });

  it('reads nothing at all for an app linked by its address alone', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-nocode-'));
    fs.writeFileSync(path.join(data, 'own.js'), inline('src/App.tsx'));
    expect(await new SourceMapper(new Project(data, app.url, data, false)).map(`${path.join(data, 'own.js')}:1:1`)).toBeNull();
  });
});
