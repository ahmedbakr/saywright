/**
 * What the command needs of Node (bin/node-env.mjs): the versions it runs on, said as the engines field means them,
 * and, behind a company proxy, one run again with Node's proxy support on, so AI requests go through the proxy and
 * this computer is reached directly.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { envProxySupported, nodeMessage, nodeSupported, noProxyWithLocal, proxyVariables } from '../../bin/node-env.mjs';

const MODULE = pathToFileURL(path.resolve(__dirname, '../../bin/node-env.mjs')).href;
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});
async function serve(answer: (req: http.IncomingMessage) => string): Promise<string> {
  const server = http.createServer((req, res) => res.end(answer(req)));
  // A proxy is asked for a tunnel (CONNECT host:port), then the request comes through it: answered here.
  server.on('connect', (req: http.IncomingMessage, socket: import('node:net').Socket) => {
    const body = answer(req);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A command that starts as the studio's does: run again behind a proxy, then a request out and one to this computer. */
const COMMAND = `
import { withEnvProxy } from '${MODULE}';
const code = await withEnvProxy([process.argv[1]], (line) => console.log('SAID', line));
if (code !== null) process.exit(code);
const get = (url) => fetch(url).then((r) => r.text()).catch((e) => 'failed ' + (e.cause?.code ?? e.message));
console.log('OUT', await get('http://ai.example.test/v1/models'));
console.log('HERE', await get(process.env.LOCAL_URL));
if (process.env.WAIT) {
  let signals = 0;
  process.on('SIGTERM', () => {
    signals++;
    setTimeout(() => { console.log('SIGNALS', signals); process.exit(0); }, 300);
  });
  console.log('WAITING');
  setInterval(() => {}, 1000);
}
`;

function run(env: Record<string, string>, onLine?: (line: string, child: ReturnType<typeof spawn>) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-proxy-'));
  fs.writeFileSync(path.join(dir, 'command.mjs'), COMMAND);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|no_proxy|node_use_env_proxy)$/i.test(k)));
  const child = spawn(process.execPath, [path.join(dir, 'command.mjs')], { env: { ...clean, ...env } });
  let out = '';
  child.stderr!.on('data', (d: Buffer) => (out += d));
  child.stdout!.on('data', (d: Buffer) => {
    out += d;
    for (const line of d.toString().split('\n')) if (line) onLine?.(line, child);
  });
  return new Promise<{ out: string; code: number | null }>((resolve) => child.on('close', (code) => resolve({ out, code })));
}

describe('the Node versions Saywright runs on', () => {
  it('are the engines field’s, and the message says them as it means them', () => {
    for (const v of ['22.18.0', '22.22.0', '24.11.0', '25.1.0']) expect(nodeSupported(v), v).toBe(true);
    for (const v of ['20.19.0', '22.17.1', '23.11.0', '24.0.0', '24.10.0']) expect(nodeSupported(v), v).toBe(false);
    expect(nodeMessage('23.11.0')).toBe('Saywright needs Node.js 22 (22.18 or newer) or Node.js 24 and later (24.11 or newer); this is 23.11.0.');
  });
});

describe('behind a company proxy', () => {
  it('knows which variables are set, by name, and keeps this computer out of the proxy', () => {
    expect(proxyVariables({ https_proxy: 'http://user:secret@proxy:3128', NO_PROXY: 'corp.example' })).toEqual(['https_proxy']);
    expect(noProxyWithLocal({ no_proxy: 'corp.example, localhost' })).toBe('corp.example,localhost,127.0.0.1,::1');
    expect(noProxyWithLocal({})).toBe('localhost,127.0.0.1,::1');
    expect(envProxySupported('22.20.0')).toBe(false);
    expect(envProxySupported('22.21.0')).toBe(true);
  });

  it.runIf(envProxySupported())('runs the command again once: requests out go through the proxy, those to this computer don’t', async () => {
    const proxy = await serve((req) => `through the proxy: ${req.url}`);
    const local = await serve(() => 'direct');
    const { out, code } = await run({ HTTP_PROXY: proxy, LOCAL_URL: local.replace('127.0.0.1', 'localhost') });
    expect(code).toBe(0);
    expect(out).toMatch(/OUT through the proxy: (http:\/\/)?ai\.example\.test(:80)?/);
    expect(out).toContain('HERE direct');
    // One line says so, naming the variable and never its value.
    expect(out.match(/^SAID /gm)).toHaveLength(1);
    expect(out).toMatch(/SAID\s+AI requests go through the proxy in HTTP_PROXY/);
    expect(out).not.toContain(proxy);
    expect(out).not.toMatch(/Warning/);
  }, 20_000);

  it('without a proxy, or with NODE_USE_ENV_PROXY set already, runs once, as it is', async () => {
    const local = await serve(() => 'direct');
    const { out } = await run({ LOCAL_URL: local });
    expect(out).not.toMatch(/^SAID/m);
    expect(out).toMatch(/^OUT failed/m);
    const proxy = await serve((req) => `through the proxy: ${req.url}`);
    const set = await run({ HTTP_PROXY: proxy, NODE_USE_ENV_PROXY: '1', LOCAL_URL: local });
    expect(set.out).not.toMatch(/^SAID/m);
  }, 20_000);

  it.runIf(envProxySupported() && process.platform !== 'win32')('passes a signal on once, and the command’s exit code back', async () => {
    const proxy = await serve(() => 'ok');
    const local = await serve(() => 'direct');
    const { out, code } = await run({ HTTP_PROXY: proxy, LOCAL_URL: local, WAIT: '1' }, (line, child) => {
      if (line === 'WAITING') child.kill('SIGTERM');
    });
    expect(out).toContain('SIGNALS 1');
    expect(code).toBe(0);
  }, 20_000);
});
