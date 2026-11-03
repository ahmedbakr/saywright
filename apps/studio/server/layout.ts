/**
 * Where the studio finds its parts and keeps its data. Run from this repository (`npm run dev`), its data is in
 * .saywright/ at the repository's root; installed from npm (`npx saywright`), in .saywright/ in your home folder.
 * SAYWRIGHT_HOME moves it anywhere.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { readEnvFiles } from './env.ts';

export interface StudioLayout {
  /** The studio's data: settings, linked apps, usage, speech models. */
  dataDir: string;
  /** Where .env and .env.local are read, and where keys saved from Settings are written (readable by you alone). */
  envDir: string;
  /** The studio's version, from its package.json. */
  version: string;
  /** What downloads the optional extras (speech models, test browser), as typed in a terminal. */
  setupCommand: string;
  /** The script that makes an app pointable: the bridge, as built (packages/vite/dist/bridge.js). */
  bridgeFile: string;
  /** axe-core, loaded into an app's page for the accessibility checks. */
  axeFile: string;
  /** The speech engine's worker, started as a child process. */
  speechWorker: string;
  /** How an AI app that starts its MCP servers as programs (Claude Desktop) reaches the studio. */
  mcpCommand: { command: string; args: string[] };
  /**
   * The sample shop: `source` ships with the studio; `root` is where it is used and changed. In the repository they
   * are the same folder; installed, the sample is copied into the data folder the first time it is opened.
   */
  sample: { source: string; root: string };
}

const versionOf = (dir: string): string => (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
const dataHome = (otherwise: () => string): string => {
  const env = process.env.SAYWRIGHT_HOME;
  return env ? path.resolve(env) : otherwise();
};

/** Run from this repository; `root` is its top folder. */
export function repoLayout(root: string): StudioLayout {
  const studio = path.join(root, 'apps', 'studio');
  return {
    dataDir: dataHome(() => path.join(root, '.saywright')),
    envDir: root,
    version: versionOf(studio),
    setupCommand: 'npm run setup',
    bridgeFile: path.join(root, 'packages', 'vite', 'dist', 'bridge.js'),
    axeFile: createRequire(path.join(studio, 'package.json')).resolve('axe-core/axe.min.js'),
    speechWorker: path.join(studio, 'server', 'speech', 'worker.mjs'),
    mcpCommand: { command: process.execPath, args: [path.join(root, 'scripts', 'mcp-stdio.mjs')] },
    sample: { source: path.join(root, 'apps', 'shop'), root: path.join(root, 'apps', 'shop') },
  };
}

/** Installed from npm; `pkg` is the package's folder, with the studio built into its dist/. */
export function packageLayout(pkg: string): StudioLayout {
  const dataDir = dataHome(() => path.join(os.homedir(), '.saywright'));
  return {
    dataDir,
    envDir: dataDir,
    version: versionOf(pkg),
    setupCommand: 'npx saywright setup',
    bridgeFile: path.join(pkg, 'dist', 'bridge.js'),
    axeFile: path.join(pkg, 'dist', 'axe.min.js'),
    speechWorker: path.join(pkg, 'dist', 'server', 'speech-worker.mjs'),
    mcpCommand: { command: process.execPath, args: [path.join(pkg, 'bin', 'saywright.mjs'), 'mcp'] },
    sample: { source: path.join(pkg, 'dist', 'sample'), root: path.join(dataDir, 'sample-shop') },
  };
}

/**
 * Where speech models are kept: SAYWRIGHT_SPEECH_DIR (from the environment or the studio's .env files), else speech/
 * in the data folder. `setup` and `doctor` find the same folder as the studio, without reading the files into theirs.
 */
export function speechDir(layout: Pick<StudioLayout, 'dataDir' | 'envDir'>): string {
  return ({ ...process.env, ...readEnvFiles(layout.envDir) }).SAYWRIGHT_SPEECH_DIR || path.join(layout.dataDir, 'speech');
}
