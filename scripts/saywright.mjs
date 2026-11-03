#!/usr/bin/env node
// The `saywright` command, run from this repository's sources (installed from npm it is the package's
// bin/saywright.mjs, built). `npm run connect`, `npm run setup`, `npm run doctor` and scripts/mcp-stdio.mjs come here.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { runnerImport } from 'vite';
import { moveOldModels, PLUGIN_DIR, ROOT, STUDIO_DIR } from './lib/paths.mjs';

/** Run a command; resolves with its exit code. */
export async function saywright(argv) {
  if (argv[0] === 'setup') moveOldModels();
  // Vite runs the TypeScript sources directly; it logs nothing (the mcp command's output is the protocol).
  const { module } = await runnerImport(path.join(STUDIO_DIR, 'cli/index.ts'), { configFile: false, logLevel: 'silent', root: STUDIO_DIR });
  return module.main(argv, { layout: module.repoLayout(ROOT), clientDir: null, pluginSpec: PLUGIN_DIR, startCommand: 'npm run dev' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await saywright(process.argv.slice(2));
