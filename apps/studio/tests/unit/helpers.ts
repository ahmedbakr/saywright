import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from '../../server/project';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHOP = path.resolve(here, '../../../shop');

/** A throwaway copy of the sample shop, so tests can edit files freely. */
export function tempShop(): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-shop-'));
  for (const item of ['src', 'saywright.config.json', 'package.json']) {
    fs.cpSync(path.join(SHOP, item), path.join(dir, item), { recursive: true });
  }
  return new Project(dir, 'http://localhost:5174');
}

/** Find the 1-based line/col of the first JSX element whose opening tag starts with `needle`. */
export function locOf(code: string, needle: string): { line: number; col: number } {
  const i = code.indexOf(needle);
  if (i < 0) throw new Error(`not found: ${needle}`);
  const before = code.slice(0, i);
  const line = before.split('\n').length;
  const col = i - before.lastIndexOf('\n');
  return { line, col };
}

export function srcOf(project: Project, file: string, needle: string): string {
  const { line, col } = locOf(project.read(file), needle);
  return `${file}:${line}:${col}`;
}

/** A folder with these files: an object is written as JSON, a name ending in / is an empty folder. */
export function tree(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-app-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(file, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** Only these programs (and npm, which comes with Node) can be run by name until `restore()`: PATH is a folder of stand-ins. */
export function programs(...names: string[]): { restore: () => void } {
  const saved = process.env.PATH;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-bin-'));
  // As each system has them: a script with the right to run, or on Windows a .cmd file (found through PATHEXT).
  for (const name of names) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${name}.cmd`), '@echo off\r\n');
    else fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  }
  process.env.PATH = bin;
  return { restore: () => void (process.env.PATH = saved) };
}

/** A Vite config like Excalidraw's: React, and a port worked out from an environment variable. */
export const VITE_REACT = `import { defineConfig, loadEnv } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, '../');\n  return {\n    server: { port: Number(env.VITE_APP_PORT || 3000), open: true },\n    plugins: [react()],\n  };\n});\n`;

/**
 * Excalidraw's layout: yarn workspaces with Vite and the React plugin in the top package.json (installed there), and
 * the app in its own folder. `extra` adds files (e.g. the plugin, installed for the workspace).
 */
export function monorepo(extra: Record<string, string | object> = {}): { root: string; app: string } {
  const root = tree({
    '.git/': '',
    'package.json': { name: 'shapes-monorepo', private: true, packageManager: 'yarn@1.22.22', workspaces: ['web', 'packages/*'], devDependencies: { vite: '5.0.12', '@vitejs/plugin-react': '3.1.0' } },
    'yarn.lock': '',
    'node_modules/.yarn-integrity': '{}',
    'node_modules/vite/package.json': { name: 'vite', version: '5.0.12' },
    'node_modules/react/package.json': { name: 'react', version: '19.0.0' },
    'web/package.json': { name: 'web', private: true, scripts: { start: 'yarn && vite', build: 'vite build' }, dependencies: { react: '19.0.0', 'react-dom': '19.0.0' } },
    'web/vite.config.mts': VITE_REACT,
    'web/index.html': '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    'packages/ui/package.json': { name: '@shapes/ui', scripts: { build: 'tsc' } },
    ...extra,
  });
  return { root, app: path.join(root, 'web') };
}
