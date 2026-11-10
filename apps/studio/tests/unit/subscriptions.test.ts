/**
 * Using a plan the person already pays for: the studio runs the official app
 * (here, a stand-in that behaves like it), which proposes the change through
 * the studio's MCP endpoint with a token for that run only. Also the MCP
 * endpoint itself, as other AI apps reach it.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CliAgent, cliJson, explain, type CliKind, type CliUsage } from '../../server/ai/cli';
import { McpServer, type McpTool } from '../../server/mcp';
import { npmShimScript } from '../../server/program';
import { tempShop } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(here, '../fixtures/fake-cli/agent.mjs');
/** The .cmd file npm writes on Windows for an app whose script is `script`, beside it. */
const npmShim = (script: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*\r\n`;
const EDIT = { path: 'src/lib/pricing.ts', old_string: 'const discount = round2((subtotal + shipping) * rate);', new_string: 'const discount = round2(subtotal * rate);' };

let base = '';
let server: http.Server;
const echo: McpTool = { name: 'echo', description: 'Says it back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, run: (a, caller) => `${caller.name}: ${String(a.text)}` };
const mcp = new McpServer({ name: 'saywright', version: '1.0.0', instructions: 'Test server.', token: () => 'client-token-'.padEnd(48, 'x'), tools: () => [echo] });
const bins: Record<CliKind, string> = { 'claude-code': '', codex: '', 'gemini-cli': '' };
const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-fake-')), 'log.json');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => void mcp.handle(req, res, raw ? JSON.parse(raw) : null));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-bin-'));
  for (const [kind, name] of [['claude-code', 'claude'], ['codex', 'codex'], ['gemini-cli', 'gemini']] as const) {
    if (process.platform === 'win32') {
      // As npm installs an app on Windows: a .cmd file that runs a script with Node, which the studio runs directly.
      fs.writeFileSync(path.join(dir, `${name}.mjs`), `process.argv.splice(2, 0, ${JSON.stringify(name)});\nawait import(${JSON.stringify(pathToFileURL(AGENT).href)});\n`);
      bins[kind] = path.join(dir, `${name}.cmd`);
      fs.writeFileSync(bins[kind], npmShim(`${name}.mjs`));
    } else {
      bins[kind] = path.join(dir, name);
      fs.writeFileSync(bins[kind], `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" ${name} "$@"\n`, { mode: 0o755 });
    }
  }
  process.env.FAKE_AGENT_LOG = logFile;
});
afterAll(() => {
  server.close();
  delete process.env.FAKE_AGENT_PLAN;
  delete process.env.FAKE_AGENT_LOG;
});

const logged = () => JSON.parse(fs.readFileSync(logFile, 'utf8')) as { args: string[]; input: string; cwd: string; env: Record<string, string | null>; firstError?: string };

function agent(kind: CliKind, used: CliUsage[] = []) {
  return new CliAgent({ kind, bin: bins[kind], model: 'default', effort: 'medium', mcp, origin: () => base, used: (u) => used.push(u) });
}

describe.each(['claude-code', 'codex', 'gemini-cli'] as const)('a change through %s', (kind) => {
  it('reads the request on stdin, proposes through the studio, and reports what it used', async () => {
    process.env.FAKE_AGENT_PLAN = JSON.stringify({ edit: EDIT });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-used';
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';
    const project = tempShop();
    const used: CliUsage[] = [];
    const steps: string[] = [];
    const out = await agent(kind, used).run({ text: 'the total is wrong, fix it', refs: [], mode: 'edit' }, { project, progress: (s, d) => steps.push(`${s} ${d ?? ''}`.trim()) });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(out.kind).toBe('change');
    if (out.kind !== 'change') return;
    expect(out.edits[0].path).toBe('src/lib/pricing.ts');
    expect(out.edits[0].after).toContain('round2(subtotal * rate)');
    // Proposed, not written: the studio previews it.
    expect(fs.readFileSync(path.join(project.root, 'src/lib/pricing.ts'), 'utf8')).toContain('(subtotal + shipping) * rate');
    const log = logged();
    expect(log.input).toContain('the total is wrong, fix it');
    expect(log.cwd).toBe(fs.realpathSync(project.root));
    expect(steps.some((s) => s.startsWith('Reading'))).toBe(true);
    expect(used.length).toBeGreaterThan(0);
    if (kind === 'claude-code') {
      // The plan, not a key; read-only tools; only the studio's MCP server; no project settings or session history.
      expect(log.env.ANTHROPIC_API_KEY).toBeNull();
      expect(log.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', 'user', '--no-session-persistence']));
      expect(log.args).not.toContain('--model');
      expect(log.input).not.toContain('You are the coding agent'); // the instructions go in the system prompt file
      expect(used[0]).toEqual({ model: 'claude-opus-5-5', usage: { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 500 }, usd: 0.042 });
    }
    if (kind === 'codex') {
      expect(log.env.OPENAI_API_KEY).toBeNull();
      expect(log.env.SAYWRIGHT_MCP_TOKEN).toMatch(/^run_/);
      expect(log.args).toEqual(expect.arrayContaining(['exec', '--json', '--ephemeral', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"']));
      expect(used[0].usage).toEqual({ input: 1000, output: 300, cacheRead: 4000, cacheWrite: 0, reasoning: 100 });
    }
    if (kind === 'gemini-cli') {
      expect(log.args).toEqual(expect.arrayContaining(['-o', 'stream-json', '--allowed-mcp-server-names', 'saywright']));
      expect(used[0]).toMatchObject({ model: 'gemini-4-argon', usage: { input: 1000, output: 100, cacheRead: 2000 } });
    }
  });
});

describe('subscription runs', () => {
  it('on Windows, starts an app npm installed by running its script with Node, as the stand-ins are installed there', () => {
    expect(npmShimScript('C:\\bin\\claude.cmd', npmShim('claude.mjs'))).toBe('C:\\bin\\claude.mjs');
  });

  it('a wrong edit is refused with the reason, and the corrected one is taken', async () => {
    process.env.FAKE_AGENT_PLAN = JSON.stringify({ edit: EDIT, badFirst: true });
    const out = await agent('claude-code').run({ text: 'fix it', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    expect(out.kind).toBe('change');
    expect(logged().firstError).toMatch(/was not found/);
  });

  it('answers a question without proposing anything', async () => {
    process.env.FAKE_AGENT_PLAN = JSON.stringify({ answer: 'In src/lib/pricing.ts:32.' });
    const out = await agent('codex').run({ text: 'where is the discount?', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    expect(out).toEqual({ kind: 'answer', text: 'In src/lib/pricing.ts:32.' });
  });

  it('says how to sign in when the app isn’t signed in', async () => {
    process.env.FAKE_AGENT_PLAN = JSON.stringify({ fail: 'Error: Not logged in · Please run /login' });
    await expect(agent('claude-code').run({ text: 'fix it', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined })).rejects.toThrow(/isn’t signed in. Run “claude” once/);
    expect(explain('codex', 'You have hit your usage limit. Try again at 4pm.')).toMatch(/usage limit is reached/);
  });

  it('a run that failed is an error, not an answer', async () => {
    process.env.FAKE_AGENT_PLAN = JSON.stringify({ apiError: 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)' });
    await expect(agent('claude-code').run({ text: 'why?', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined })).rejects.toThrow(/couldn’t reach Anthropic/);
  });

  it('the run’s token stops working when the run ends', async () => {
    process.env.FAKE_AGENT_PLAN = JSON.stringify({ edit: EDIT });
    await agent('gemini-cli').run({ text: 'fix it', refs: [], mode: 'edit' }, { project: tempShop(), progress: () => undefined });
    const settingsArg = logged();
    expect(settingsArg.args).toContain('--allowed-mcp-server-names');
    const res = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer run_000' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(res.status).toBe(401);
  });

  it.each(['claude-code', 'codex', 'gemini-cli'] as const)('writes structured output (a report) through %s', async (kind) => {
    const value = { title: 'Total is wrong', score: 3 };
    process.env.FAKE_AGENT_PLAN = JSON.stringify({ json: value });
    const used: CliUsage[] = [];
    const out = await cliJson({ kind, bin: bins[kind], model: 'default', effort: 'low', mcp, origin: () => base, used: (u) => used.push(u) }, { system: 'You write reports.', prompt: 'Write it.', schema: z.object({ title: z.string(), score: z.number() }), images: [{ name: 'S1', data: Buffer.from('jpeg').toString('base64') }], cwd: tempShop().root });
    expect(out).toEqual(value);
    expect(used.length).toBe(1);
    const log = logged();
    if (kind === 'claude-code') expect(log.args).toContain('--json-schema');
    if (kind === 'codex') expect(log.args).toEqual(expect.arrayContaining(['--output-schema', '--image']));
    if (kind === 'gemini-cli') expect(log.input).toContain('JSON Schema');
  });
});

describe('the MCP endpoint', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'client-token-'.padEnd(48, 'x')}`, ...headers }, body: JSON.stringify(body) });

  it('speaks the handshake protocol and the stateless one', async () => {
    const init = (await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Cursor' } } })).json()) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('saywright');
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const discover = (await (await post({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } })).json()) as { result: { supportedVersions: string[]; resultType: string } };
    expect(discover.result.supportedVersions).toContain('2026-07-28');
    expect(discover.result.resultType).toBe('complete');
    const old = (await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } } })).json()) as { error: { code: number } };
    expect(old.error.code).toBe(-32022);
    const list = (await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).json()) as { result: { tools: { name: string }[]; ttlMs: number } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['echo']);
    const call = (await (await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' }, _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai' } } } })).json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(call.result).toMatchObject({ isError: false, content: [{ text: 'claude-ai: hi' }] });
    const unknown = (await (await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
  });

  it('refuses without the token (saying where to copy it from), from web pages, and for other hosts', async () => {
    const wrong = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer wrong' });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toMatch(/Settings → Other AI apps\.$/);
    // As many characters as the real one, with a letter that takes two bytes: still a refusal, not a server error.
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${'client-token-'.padEnd(47, 'x')}é` })).status).toBe(401);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Origin: 'https://evil.example' })).status).toBe(403);
    const port = new URL(base).port;
    const foreign = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/mcp', method: 'POST', headers: { Host: `attacker.example:${port}`, 'Content-Type': 'application/json' } }, (res) => resolve(res.statusCode ?? 0));
      req.end('{}');
    });
    expect(foreign).toBe(421);
    expect((await fetch(`${base}/api/mcp`, { headers: { Authorization: 'Bearer x' } })).status).toBe(405);
  });
});
