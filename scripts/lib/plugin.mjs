// The Vite plugin and the bridge it injects are built into packages/vite/dist.
// After a pull, its sources can be newer than the build: rebuild before serving, or apps get the old bridge.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_DIR } from './paths.mjs';

function newest(dir) {
  let t = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    t = Math.max(t, entry.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

/** Whether dist is missing or older than the plugin's sources. */
function pluginStale() {
  const built = ['dist/bridge.js', 'dist/index.js', 'dist/protocol.js'].map((f) => path.join(PLUGIN_DIR, f));
  if (!built.every((f) => fs.existsSync(f))) return true;
  const builtAt = Math.min(...built.map((f) => fs.statSync(f).mtimeMs));
  return Math.max(newest(path.join(PLUGIN_DIR, 'src')), fs.statSync(path.join(PLUGIN_DIR, 'build.mjs')).mtimeMs) > builtAt;
}

/** Build the plugin if it is out of date. Returns false if the build failed. */
export function ensurePlugin({ log = () => undefined } = {}) {
  if (!pluginStale()) return true;
  log();
  return spawnSync(process.execPath, [path.join(PLUGIN_DIR, 'build.mjs')], { stdio: 'inherit' }).status === 0;
}
