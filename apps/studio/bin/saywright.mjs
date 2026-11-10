#!/usr/bin/env node
// The `saywright` command (apps/studio/cli in the repository): checks Node, then runs the built command.
import { nodeMessage, nodeSupported, withEnvProxy } from './node-env.mjs';

if (!nodeSupported()) {
  console.error(`${nodeMessage()} Install the current LTS from https://nodejs.org.`);
  process.exit(1);
}
const args = process.argv.slice(2);
// The command that starts the studio, behind a company proxy: run again once, so AI requests go through the proxy.
// The others (--version, --help, connect, setup, doctor, mcp) stay as they are: mcp writes nothing but its protocol.
const starts = !args.some((a) => a === '--help' || a === '-h') && (!args.length || args[0] === 'start' || (args[0].startsWith('-') && args[0] !== '--version' && args[0] !== '-v'));
const code = starts ? await withEnvProxy([process.argv[1], ...args]) : null;
if (code !== null) process.exit(code);
const { main } = await import('../dist/cli.mjs');
process.exitCode = await main(args);
