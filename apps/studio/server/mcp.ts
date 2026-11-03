/**
 * Saywright as an MCP server, at /api/mcp on the studio's own address.
 *
 * Two kinds of callers:
 * - AI apps the person uses (Claude Desktop, Claude Code, Cursor, VS Code,
 *   Codex…), with the studio's token: they see what the person is pointing at
 *   and propose changes the person keeps or undoes in the studio.
 * - The studio's own runs of a subscription app (Claude Code, Codex, Gemini
 *   CLI), each with a token that lives for that one request and offers only
 *   propose_change.
 *
 * Streamable HTTP, answered as plain JSON. Speaks both the stateless protocol
 * (2026-07-28: server/discover, per-request metadata) and the earlier
 * handshake versions (initialize), so current and older clients both work.
 * Localhost only: requests naming another host or coming from a web page on
 * another origin are refused.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { writeFileAtomic } from './fsx.ts';

const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: Record<string, unknown>, caller: McpCaller) => Promise<string | { text: string; data?: unknown }> | string | { text: string; data?: unknown };
}

interface McpCaller {
  /** "client": an AI app with the studio's token; "run": one of the studio's own subscription runs. */
  kind: 'client' | 'run';
  /** The calling app's name, when it said ("claude-ai", "cursor"…). */
  name: string;
  runId?: string;
}

class McpError extends Error {
  constructor(
    message: string,
    public code = -32602,
  ) {
    super(message);
  }
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** The studio's MCP token, created when the studio starts (or on first use), readable by this user only. */
export function clientToken(dataDir: string): string {
  const file = path.join(dataDir, 'mcp-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(t)) return t;
  } catch {
    /* first use */
  }
  const t = crypto.randomBytes(24).toString('hex');
  writeFileAtomic(file, t + '\n', { mode: 0o600 });
  return t;
}

const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class McpServer {
  private runs = new Map<string, { id: string; tools: McpTool[] }>();

  constructor(
    private opts: {
      name: string;
      version: string;
      instructions: string;
      token: () => string;
      /** Tools for AI apps with the studio's token. */
      tools: () => McpTool[];
    },
  ) {}

  /** A token for one of the studio's own runs, offering only `tools`. Close it when the run ends. */
  openRun(tools: McpTool[]): { token: string; close: () => void } {
    const token = `run_${crypto.randomBytes(18).toString('hex')}`;
    this.runs.set(token, { id: token.slice(4, 16), tools });
    return { token, close: () => this.runs.delete(token) };
  }

  private caller(req: IncomingMessage): { caller: McpCaller; tools: McpTool[] } | null {
    const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!auth) return null;
    const run = this.runs.get(auth);
    if (run) return { caller: { kind: 'run', name: 'saywright-run', runId: run.id }, tools: run.tools };
    if (same(auth, this.opts.token())) return { caller: { kind: 'client', name: 'client' }, tools: this.opts.tools() };
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}): void => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      if (payload === undefined) {
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    if (!LOCAL.test(req.headers.host ?? '')) return send(421, { error: 'Saywright’s MCP server answers on localhost only.' });
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return send(403, { error: 'Requests from web pages are not accepted.' });
    if (req.method === 'GET' || req.method === 'DELETE') return send(405, undefined, { Allow: 'POST' });
    if (req.method !== 'POST') return send(405, undefined, { Allow: 'POST' });
    const who = this.caller(req);
    if (!who) return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or wrong token. Copy the connection settings from Saywright → Settings → Other AI apps.' } }, { 'WWW-Authenticate': 'Bearer realm="saywright"' });
    const clientName = req.headers['user-agent'] ? String(req.headers['user-agent']).split(/[\s/]/)[0] : 'client';
    who.caller.name = who.caller.kind === 'client' ? clientName : who.caller.name;

    const batch = Array.isArray(body);
    const items = (batch ? body : [body]) as RpcRequest[];
    const out: unknown[] = [];
    for (const r of items) {
      const reply = await this.dispatch(r, who.caller, who.tools);
      if (reply) out.push(reply);
    }
    if (!out.length) return send(202);
    return send(200, batch ? out : out[0]);
  }

  private async dispatch(r: RpcRequest, caller: McpCaller, tools: McpTool[]): Promise<unknown | null> {
    if (!r || typeof r !== 'object' || typeof r.method !== 'string') return { jsonrpc: '2.0', id: r?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    const notification = r.id === undefined || r.id === null;
    const meta = r.params?._meta ?? {};
    const version = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string' ? (meta['io.modelcontextprotocol/protocolVersion'] as string) : null;
    const clientInfo = meta['io.modelcontextprotocol/clientInfo'] as { name?: string } | undefined;
    if (clientInfo?.name && caller.kind === 'client') caller.name = clientInfo.name;
    const ok = (result: Record<string, unknown>) => (notification ? null : { jsonrpc: '2.0', id: r.id, result: { ...result, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': this.info() } } });
    const fail = (code: number, message: string, data?: unknown) => (notification ? null : { jsonrpc: '2.0', id: r.id, error: { code, message, ...(data ? { data } : {}) } });

    if (version && !MODERN.includes(version) && !LEGACY.includes(version)) return fail(-32022, 'Unsupported protocol version', { supported: [...MODERN, ...LEGACY], requested: version });

    try {
      switch (r.method) {
        case 'initialize': {
          const asked = String(r.params?.protocolVersion ?? '');
          const ci = r.params?.clientInfo as { name?: string } | undefined;
          if (ci?.name && caller.kind === 'client') caller.name = ci.name;
          return ok({ protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: { listChanged: false } }, serverInfo: this.info(), instructions: this.opts.instructions });
        }
        case 'server/discover':
          return ok({ supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: { listChanged: false } }, serverInfo: this.info(), instructions: this.opts.instructions });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({
            tools: tools.map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
            ttlMs: 60_000,
            cacheScope: 'private',
          });
        case 'tools/call': {
          const name = String(r.params?.name ?? '');
          const tool = tools.find((t) => t.name === name);
          if (!tool) return fail(-32602, `Unknown tool: ${name}`);
          const args = (r.params?.arguments ?? {}) as Record<string, unknown>;
          try {
            const out = await tool.run(args, caller);
            const text = typeof out === 'string' ? out : out.text;
            const data = typeof out === 'string' ? undefined : out.data;
            return ok({ content: [{ type: 'text', text }], ...(data !== undefined ? { structuredContent: data } : {}), isError: false });
          } catch (err) {
            // A tool's own failure goes back to the model as a result it can act on, not a protocol error.
            return ok({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
          }
        }
        default:
          if (r.method.startsWith('notifications/')) return null;
          return fail(-32601, `Method not found: ${r.method}`);
      }
    } catch (err) {
      return fail(err instanceof McpError ? err.code : -32603, err instanceof Error ? err.message : String(err));
    }
  }

  private info() {
    return { name: this.opts.name, title: 'Saywright', version: this.opts.version };
  }
}
