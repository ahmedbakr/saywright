#!/usr/bin/env node
// The `saywright` command (apps/studio/cli in the repository): checks Node, then runs the built command.
// The current LTS lines, 22.18 and newer or 24.11 and newer: Babel, which reads the app's code, needs them.
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major > 24)) {
  console.error(`Saywright needs Node.js 22.18 or newer (or 24.11 or newer); this is ${process.versions.node}. Install the current LTS from https://nodejs.org.`);
  process.exit(1);
}
const { main } = await import('../dist/cli.mjs');
process.exitCode = await main(process.argv.slice(2));
