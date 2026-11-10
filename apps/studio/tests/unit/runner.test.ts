/**
 * Dev servers the studio starts for linked apps: where they listen is read from what they print (their "Local" line,
 * not the first local address a plugin prints), they are followed when their port moves, their state stays true to
 * the process (a server that stopped is never shown running), and nothing they started outlives Stop.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { LinkedApp } from '../../shared/apps';
import { AppRunner, addressesIn, pickUrl, urlFromOutput } from '../../server/apps/runner';

const VUE_ADMIN = `
  ➜ MCP:      Mcp server is running at http://localhost:3302/__mcp/sse
[MCP] Updated config file /home/me/vue-admin/.cursor/mcp.json
Port 3302 is in use, trying another one...
Port 3303 is in use, trying another one...
  VITE v7.3.6  ready in 2848 ms
  ➜  Local:   http://localhost:3305/
  ➜  Network: http://192.0.2.2:3305/
`;

describe('where a dev server says it listens', () => {
  it('is its "Local" line, though a plugin printed another local address first', () => {
    expect(urlFromOutput(VUE_ADMIN)).toBe('http://localhost:3305/');
    expect(addressesIn(VUE_ADMIN)).toEqual([
      { url: 'http://localhost:3302/__mcp/sse', local: false },
      { url: 'http://localhost:3305/', local: true },
    ]);
  });

  it('reads the frameworks’ own ways of saying it', () => {
    expect(urlFromOutput('▲ Next.js 16.4.2 (Turbopack)\n- Local:         http://localhost:3301\n- Network:       http://192.0.2.2:3301\n✓ Ready in 790ms')).toBe('http://localhost:3301');
    expect(urlFromOutput(' astro  v5.7.0 ready in 412 ms\n\n┃ Local    http://localhost:4321/\n┃ Network  use --host to expose')).toBe('http://localhost:4321/');
    expect(urlFromOutput('[INFO] Starting the development server...\n[SUCCESS] Docusaurus website is running at: http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(urlFromOutput('<i> [webpack-dev-server] Project is running at:\n<i> [webpack-dev-server] Loopback: http://localhost:8080/, http://[::1]:8080/')).toBe('http://localhost:8080/');
    expect(urlFromOutput('{"message":"Dev server running at http://localhost:3304 (pid 15284)\\n  Stop:   astro dev stop","label":"SKIP_FORMAT","level":"info"}')).toBe('http://localhost:3304');
    expect(urlFromOutput('\x1b[32m  ➜  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toBe('http://localhost:5173/');
  });

  it('keeps an address with a path only from the "Local" line (an app served under /app/), never a plugin’s endpoint', () => {
    expect(urlFromOutput('  ➜  Local:   http://localhost:5173/app/')).toBe('http://localhost:5173/app/');
    expect(urlFromOutput('  ➜ Inspect: http://localhost:5173/__inspect/\n  ➜ DevTools: http://localhost:5173/__devtools__/')).toBeNull();
    expect(pickUrl([{ url: 'http://localhost:3302/__mcp/sse', local: false }])).toBeNull();
  });
});

// Dev servers for the runner to start: small scripts in a folder of their own.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-runner-'));
const script = (name: string, code: string) => {
  fs.writeFileSync(path.join(dir, name), code);
  return `node ${name}`;
};
const app = (id: string, start: string): LinkedApp => ({ id, name: id, root: dir, start, framework: 'vite', envs: [{ id: 'local', label: 'Local', url: 'http://localhost:1', kind: 'local', connection: 'proxy' }], env: 'local', createdAt: 0, openedAt: 0 });

/** An HTTP server on a free port, answering after `delay` ms. */
async function site(delay = 0): Promise<{ url: string; port: number; close: () => void }> {
  const server = http.createServer((_req, res) => setTimeout(() => res.end('ok'), delay));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}`, port, close: () => server.close() };
}
/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = await site();
  s.close();
  return s.port;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end && !check(); ) await new Promise((r) => setTimeout(r, 50));
  return check();
};

const runner = new AppRunner(() => undefined);
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
afterAll(() => runner.stopAll());

// These start real processes: on a busy computer (tests run side by side) a child can take seconds to start.
describe('starting a dev server', { timeout: 60_000 }, () => {
  it('follows it to the "Local" address it prints after a plugin’s, across pieces of output', async () => {
    const real = await site();
    const busy = await closedPort();
    cleanups.push(real.close);
    const start = script('mcp.mjs', `console.log('  ➜ MCP:      Mcp server is running at http://localhost:${busy}/__mcp/sse');\nsetTimeout(() => console.log('  ➜  Local:   ${real.url}/'), 600);\nsetInterval(() => {}, 1000);\n`);
    await runner.start(app('mcp', start));
    expect(await runner.ready('mcp', `http://localhost:${busy}`, 20_000)).toBe(`${real.url}/`);
    expect(runner.get('mcp')).toMatchObject({ status: 'running', url: `${real.url}/` });
    await runner.stop('mcp');
  });

  it('is not settled on another address it printed first (its API): its "Local" line a while later wins', async () => {
    // Like `concurrently "node api.js" "vite"`: the API says where it listens at once and answers 404 JSON there; the
    // web server's "Local" line comes two seconds later.
    const api = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(`{"error":"Cannot GET ${req.url}"}`);
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => api.close());
    const apiUrl = `http://localhost:${(api.address() as AddressInfo).port}`;
    const web = await site();
    cleanups.push(web.close);
    const start = script('fullstack.mjs', `console.log('[api] API listening on ${apiUrl}');\nsetTimeout(() => console.log('[web]   ➜  Local:   ${web.url}/'), 2000);\nsetInterval(() => {}, 1000);\n`);
    await runner.start(app('fullstack', start));
    expect(await runner.ready('fullstack', `http://localhost:${await closedPort()}`, 20_000)).toBe(`${web.url}/`);
    expect(runner.get('fullstack').url).toBe(`${web.url}/`);
    await runner.stop('fullstack');
  });

  it('prefers the app’s own address, when it answers with a page, to another address it printed without a "Local" line', async () => {
    const other = await site();
    const own = await site();
    cleanups.push(other.close, own.close);
    const start = script('tool.mjs', `console.log('Tool ready at ${other.url}');\nsetInterval(() => {}, 1000);\n`);
    await runner.start(app('tool', start));
    expect(await runner.ready('tool', own.url, 20_000)).toBe(own.url);
    await runner.stop('tool');
  });

  it('never settles on a printed address that answers with something that is not a page', async () => {
    const api = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => api.close());
    const start = script('apionly.mjs', `console.log('API on http://localhost:${(api.address() as AddressInfo).port}');\nsetInterval(() => {}, 1000);\n`);
    await runner.start(app('apionly', start));
    expect(await runner.ready('apionly', null, 5000)).toBeNull();
    await runner.stop('apionly');
  });

  it('keeps reading where it listens once it runs: a "Local" line printed later corrects the address', async () => {
    const first = await site();
    const later = await site();
    cleanups.push(first.close, later.close);
    const moves: string[] = [];
    const watching = new AppRunner(() => undefined, (_id, url) => moves.push(url));
    cleanups.push(() => watching.stopAll());
    const start = script('later.mjs', `console.log('Tool ready at ${first.url}');\nsetTimeout(() => console.log('  ➜  Local:   ${later.url}/'), 5000);\nsetInterval(() => {}, 1000);\n`);
    await watching.start(app('later', start));
    expect(await watching.ready('later', null, 20_000)).toBe(first.url);
    expect(await until(() => watching.get('later').url === `${later.url}/`, 10_000)).toBe(true);
    expect(moves).toEqual([`${later.url}/`]);
    await watching.stop('later');
  });

  it('when time is up, tries every address it printed before giving up', async () => {
    const real = await site();
    cleanups.push(real.close);
    // It only prints a plugin's address on the port it really uses, never a "Local" line.
    const start = script('quiet.mjs', `console.log('  ➜ MCP: Mcp server is running at ${real.url}/__mcp/sse');\nsetInterval(() => {}, 1000);\n`);
    await runner.start(app('quiet', start));
    expect(await runner.ready('quiet', `http://localhost:${await closedPort()}`, 5000)).toBe(real.url);
    expect(runner.get('quiet').status).toBe('running');
    await runner.stop('quiet');
  });

  it('waits for a first page that takes long to compile, and opens it if it is still compiling when time is up', async () => {
    // Takes the request at once, answers after 2.5 s (a check that gives up after 2.5 s never sees it).
    const slow = await site(2600);
    cleanups.push(slow.close);
    const start = script('compiles.mjs', `console.log('  ➜  Local:   ${slow.url}/');\nsetInterval(() => {}, 1000);\n`);
    await runner.start(app('compiles', start));
    expect(await runner.ready('compiles', null, 20_000)).toBe(`${slow.url}/`);
    await runner.stop('compiles');
    // Still compiling when time is up: it is there, so it opens, and the page shows when it is ready.
    const slower = await site(30_000);
    cleanups.push(slower.close);
    await runner.start(app('compiles2', script('compiles2.mjs', `console.log('  ➜  Local:   ${slower.url}/');\nsetInterval(() => {}, 1000);\n`)));
    expect(await runner.ready('compiles2', null, 5000)).toBe(`${slower.url}/`);
    expect(runner.get('compiles2').status).toBe('running');
    await runner.stop('compiles2');
  });

  it('shows the error page of a server that answers with one, rather than saying it didn’t start', async () => {
    const broken = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end('Error: Cannot find module ./Widget');
    });
    await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => broken.close());
    const url = `http://localhost:${(broken.address() as AddressInfo).port}/`;
    await runner.start(app('broken', script('broken.mjs', `console.log('  ➜  Local:   ${url}');\nsetInterval(() => {}, 1000);\n`)));
    expect(await runner.ready('broken', null, 20_000)).toBe(url);
    await runner.stop('broken');
  });

  it('never shows a server as running when it stopped while being checked', async () => {
    // Its address answers slowly, and the command exits while the studio is asking (checks start within 0.5 s).
    const slow = await site(2000);
    cleanups.push(slow.close);
    const start = script('exits.mjs', `console.log('  ➜  Local:   ${slow.url}/');\nsetTimeout(() => process.exit(3), 1000);\n`);
    await runner.start(app('exits', start));
    expect(await runner.ready('exits', null, 20_000)).toBeNull();
    expect(runner.get('exits')).toMatchObject({ status: 'crashed', exitCode: 3 });
  });

  it('stops everything the command started, its children too', async () => {
    const port = await closedPort();
    const start = script('parent.mjs', `import { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, ['-e', "require('http').createServer((q, s) => s.end('child')).listen(${port}, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:${port}/ (pid ' + process.pid + ')'))"], { stdio: 'inherit' });\nsetInterval(() => {}, 1000);\n`);
    await runner.start(app('family', start));
    expect(await runner.ready('family', null, 20_000)).toBe(`http://localhost:${port}/`);
    const pid = Number(/\(pid (\d+)\)/.exec(runner.get('family').log.join('\n'))![1]);
    expect(alive(pid)).toBe(true);
    await runner.stop('family');
    expect(await until(() => !alive(pid))).toBe(true);
    expect(runner.get('family').status).toBe('stopped');
  });
});

describe('a dev server that moves itself to the background (astro dev --background)', { timeout: 60_000 }, () => {
  /** Like Astro: start the server detached, say where it is and its pid, and exit. */
  const launcher = async (name: string) => {
    const port = await closedPort();
    fs.writeFileSync(path.join(dir, `${name}-server.mjs`), `import http from 'node:http';\nhttp.createServer((q, s) => s.end('bg')).listen(${port}, '127.0.0.1');\n`);
    const start = script(`${name}.mjs`, `import { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, ['${name}-server.mjs'], { detached: true, stdio: 'ignore' });\nchild.unref();\nawait new Promise((r) => setTimeout(r, 400));\nconsole.log(JSON.stringify({ message: 'Dev server running at http://localhost:${port} (pid ' + child.pid + ')\\n  Stop:   astro dev stop', label: 'SKIP_FORMAT', level: 'info' }));\n`);
    return { port, start };
  };

  it('is the app’s server from then on: running while it runs, and stopped with Stop', async () => {
    const { port, start } = await launcher('bg');
    await runner.start(app('bg', start));
    expect(await runner.ready('bg', null, 20_000)).toBe(`http://localhost:${port}`);
    expect(await until(() => runner.get('bg').log.some((l) => /background/.test(l)))).toBe(true);
    const pid = Number(/\(pid (\d+)\)/.exec(runner.get('bg').log.join('\n'))![1]);
    expect(runner.get('bg').status).toBe('running');
    expect(alive(pid)).toBe(true);
    await runner.stop('bg');
    expect(await until(() => !alive(pid))).toBe(true);
    expect(runner.get('bg').status).toBe('stopped');
  });

  it('is stopped when the studio closes', async () => {
    const { start } = await launcher('bg2');
    await runner.start(app('bg2', start));
    expect(await runner.ready('bg2', null, 20_000)).toMatch(/^http:\/\/localhost:\d+$/);
    expect(await until(() => runner.get('bg2').log.some((l) => /background/.test(l)))).toBe(true);
    const pid = Number(/\(pid (\d+)\)/.exec(runner.get('bg2').log.join('\n'))![1]);
    runner.stopAll();
    expect(await until(() => !alive(pid))).toBe(true);
  });
});

describe('a folder of HTML the studio serves', () => {
  it('keeps the encoding a page names itself, and serves the others as UTF-8', async () => {
    const site = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-static-'));
    fs.writeFileSync(path.join(site, 'index.html'), Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>Caf\xe9</body></html>', 'latin1'));
    fs.writeFileSync(path.join(site, 'plain.html'), '<p>Café</p>');
    const served: LinkedApp = { ...app('static', ''), root: site, start: null, framework: 'static' };
    const run = await runner.start(served);
    try {
      const own = await fetch(`${run.url}/`);
      expect(own.headers.get('content-type')).toBe('text/html');
      expect(Buffer.from(await own.arrayBuffer()).toString('latin1')).toContain('Caf\xe9');
      expect((await fetch(`${run.url}/plain.html`)).headers.get('content-type')).toBe('text/html; charset=utf-8');
    } finally {
      await runner.stop('static');
    }
  });
});
