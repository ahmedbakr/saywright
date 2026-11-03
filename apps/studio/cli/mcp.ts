/**
 * `saywright mcp`: Saywright for AI apps that start their MCP servers as programs (Claude Desktop). Passes each
 * message between the app (stdin and stdout) and the running studio's MCP endpoint, with the studio's token. The
 * app's MCP settings:
 *
 *   { "mcpServers": { "saywright": { "command": "npx", "args": ["-y", "@saywright/studio", "mcp"] } } }
 *
 * Nothing else may be written to stdout: it carries the protocol.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { STUDIO_URL } from '@saywright/vite/protocol';
import type { CliContext } from './index.ts';
import { c } from './term.ts';

const HELP = `
${c.bold('saywright mcp')}: Saywright for AI apps that start their MCP servers as programs (Claude Desktop)

  Put this in the app's MCP settings, and keep the studio running:
  { "mcpServers": { "saywright": { "command": "npx", "args": ["-y", "@saywright/studio", "mcp"] } } }
`;

export async function mcp(argv: string[], ctx: CliContext): Promise<number> {
  // Started by an AI app, any other argument is ignored: only a person asks for help.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(ctx.layout.dataDir, name), 'utf8').trim();
    } catch {
      return null;
    }
  };
  /** Where the studio listens (it writes this when it starts), and its token. */
  const endpoint = () => {
    let url = process.env.SAYWRIGHT_URL || STUDIO_URL;
    try {
      url = (JSON.parse(read('server.json') ?? '{}') as { url?: string }).url || url;
    } catch {
      /* the default */
    }
    return { url: `${url.replace(/\/+$/, '')}/api/mcp`, token: read('mcp-token') };
  };
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  // The studio names changes after the app that proposed them: the name the app gives when it starts.
  let client = 'mcp-client';

  return new Promise((resolve) => {
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('close', () => resolve(0));
    lines.on('line', async (line) => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const fail = (message: string) => {
        for (const m of Array.isArray(msg) ? msg : [msg]) {
          const id = (m as { id?: unknown } | null)?.id;
          if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message } });
        }
      };
      const init = (Array.isArray(msg) ? msg : [msg]).find((m) => (m as { method?: unknown } | null)?.method === 'initialize') as { params?: { clientInfo?: { name?: unknown } } } | undefined;
      if (typeof init?.params?.clientInfo?.name === 'string') client = init.params.clientInfo.name.replace(/[^\w.-]+/g, '-').slice(0, 40) || client;
      const { url, token } = endpoint();
      if (!token) return fail(`Saywright hasn’t been started on this computer yet. Start it (${ctx.startCommand}), then try again.`);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'User-Agent': client },
          body: line,
        });
        if (res.status === 202) return;
        const text = await res.text();
        if (!res.ok && !text.startsWith('{')) return fail(`Saywright answered ${res.status}.`);
        process.stdout.write(`${text.trim()}\n`);
      } catch {
        fail(`Saywright isn’t running. Start it (${ctx.startCommand}), then try again.`);
      }
    });
  });
}
