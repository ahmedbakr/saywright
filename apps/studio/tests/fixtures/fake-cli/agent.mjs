#!/usr/bin/env node
/**
 * A stand-in for Claude Code, Codex and Gemini CLI in the tests: it reads its
 * task on stdin, finds Saywright's MCP endpoint in the settings it was given
 * (as the real app would), calls propose_change there, and prints JSON lines
 * like the real app. What to do comes from FAKE_AGENT_PLAN; what it was given
 * is written to FAKE_AGENT_LOG for the test to check.
 */
import fs from 'node:fs';

const [kind, ...args] = process.argv.slice(2);
const plan = JSON.parse(process.env.FAKE_AGENT_PLAN || '{}');
let input = '';
for await (const c of process.stdin) input += c;
const log = { kind, args, input, cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null, SAYWRIGHT_MCP_TOKEN: process.env.SAYWRIGHT_MCP_TOKEN ?? null } };
if (process.env.FAKE_AGENT_LOG) fs.writeFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify(log));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (plan.fail) {
  process.stderr.write(`${plan.fail}\n`);
  process.exit(1);
}

let url = null;
let token = null;
const flag = (name) => args[args.indexOf(name) + 1];
if (kind === 'claude' && args.includes('--mcp-config')) {
  const cfg = JSON.parse(flag('--mcp-config'));
  url = cfg.mcpServers.saywright.url;
  token = cfg.mcpServers.saywright.headers.Authorization.replace(/^Bearer /, '');
} else if (kind === 'codex') {
  const c = args.find((a) => a.startsWith('mcp_servers.saywright.url='));
  if (c) url = JSON.parse(c.slice(c.indexOf('=') + 1));
  token = process.env.SAYWRIGHT_MCP_TOKEN;
} else if (kind === 'gemini' && process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) {
  const s = JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  url = s.mcpServers.saywright.httpUrl;
  token = s.mcpServers.saywright.headers.Authorization.replace(/^Bearer /, '');
}

// Gemini speaks the stateless protocol; the others the handshake one.
const modern = kind === 'gemini';
let id = 0;
async function rpc(method, params = {}) {
  const body = { jsonrpc: '2.0', method, params: modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: `fake-${kind}` } } } : params };
  if (!method.startsWith('notifications/')) body.id = ++id;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (res.status === 202) return null;
  return res.json();
}

async function propose(edit) {
  const r = await rpc('tools/call', { name: 'propose_change', arguments: { title: 'Discount covers items only', summary: 'Applies the coupon to items only.', edits: [edit] } });
  return r.result;
}

const usage = { input: 5000, output: 300, cached: 4000 };
let answer = plan.answer ?? 'Done.';
let calledTool = false;

if (url && (plan.edit || plan.badFirst)) {
  if (modern) await rpc('server/discover');
  else {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `fake-${kind}`, version: '1' } });
    await rpc('notifications/initialized');
  }
  const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);
  if (!tools.includes('propose_change')) throw new Error('no propose_change');
  if (kind === 'claude') out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', mcp_servers: [{ name: 'saywright', status: 'connected' }] });
  if (kind === 'codex') out({ type: 'thread.started', thread_id: 't1' });
  if (kind === 'gemini') out({ type: 'init', session_id: 's1', model: 'gemini-4-argon', timestamp: new Date().toISOString() });
  // Reading the code, as the app would report it.
  if (kind === 'claude') out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: `${process.cwd()}/src/lib/pricing.ts` } }] } });
  if (kind === 'codex') out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'cat src/lib/pricing.ts' } });
  if (kind === 'gemini') out({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: `${process.cwd()}/src/lib/pricing.ts` }, timestamp: '' });
  if (plan.badFirst) {
    const r = await propose({ ...plan.edit, old_string: 'this text is not in the file' });
    if (!r.isError) throw new Error('a wrong edit was accepted');
    log.firstError = r.content[0].text;
    if (process.env.FAKE_AGENT_LOG) fs.writeFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify(log));
  }
  const r = await propose(plan.edit);
  calledTool = !r.isError;
  if (r.isError) answer = `It didn’t apply: ${r.content[0].text}`;
}

if (kind === 'claude') {
  if (!calledTool) out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', mcp_servers: url ? [{ name: 'saywright', status: 'connected' }] : [] });
  out({
    type: 'result',
    subtype: 'success',
    is_error: !!plan.apiError,
    result: plan.apiError ?? (plan.json ? '' : answer),
    ...(plan.json ? { structured_output: plan.json } : {}),
    total_cost_usd: 0.042,
    num_turns: 3,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 9000, cacheCreationInputTokens: 500, costUSD: 0.042 } },
  });
} else if (kind === 'codex') {
  out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: plan.json ? JSON.stringify(plan.json) : answer } });
  out({ type: 'turn.completed', usage: { input_tokens: usage.input, cached_input_tokens: usage.cached, output_tokens: usage.output, reasoning_output_tokens: 100 } });
} else {
  out({ type: 'message', role: 'assistant', content: plan.json ? JSON.stringify(plan.json) : answer, delta: true, timestamp: '' });
  out({ type: 'result', status: 'success', timestamp: '', stats: { total_tokens: 5300, input_tokens: 3000, output_tokens: 100, cached: 2000, input: 1000, duration_ms: 5, tool_calls: 2, models: { 'gemini-4-argon': { total_tokens: 3100, input_tokens: 3000, output_tokens: 100, cached: 2000, input: 1000 } } } });
}
