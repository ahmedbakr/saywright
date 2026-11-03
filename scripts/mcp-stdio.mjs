#!/usr/bin/env node
/**
 * Saywright for AI apps that start their MCP servers as programs (Claude Desktop), run from this repository.
 * Start the studio first (npm run dev); the app's MCP settings point here:
 *
 *   { "mcpServers": { "saywright": { "command": "node", "args": ["<this folder>/scripts/mcp-stdio.mjs"] } } }
 *
 * Installed from npm, the same is `npx -y @saywright/studio mcp`.
 */
import { saywright } from './saywright.mjs';

process.exitCode = await saywright(['mcp']);
