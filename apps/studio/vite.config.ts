import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { STUDIO_PORT } from '@saywright/vite/protocol';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';
import { studioApi } from './server/index.ts';
import { repoLayout } from './server/layout.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mediapipe = JSON.parse(fs.readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve('@mediapipe/tasks-vision')), 'package.json'), 'utf8')) as { version: string };

/** MediaPipe's bundle points at a source map it doesn't ship; drop the reference so Vite doesn't warn. */
const mediapipeSourceMap: Plugin = {
  name: 'saywright-mediapipe-sourcemap',
  enforce: 'pre',
  load(id) {
    const file = id.split('?')[0];
    if (!/@mediapipe[\\/]tasks-vision[\\/]vision_bundle\.mjs$/.test(file)) return null;
    return fs.readFileSync(file, 'utf8').replace(/\/\/# sourceMappingURL=\S+\s*$/, '');
  },
};

export default defineConfig({
  plugins: [mediapipeSourceMap, react(), tailwindcss(), studioApi(repoLayout(path.resolve(here, '../..')))],
  resolve: {
    alias: { '@': path.resolve(here, 'src'), '@shared': path.resolve(here, 'shared') },
    // The plugin's protocol and session client from their sources (published, the protocol comes built).
    conditions: ['source', ...defaultClientConditions],
  },
  define: { __MEDIAPIPE_VERSION__: JSON.stringify(mediapipe.version) },
  // Pre-transform the app on start, so the first page load is quick.
  server: { port: STUDIO_PORT, warmup: { clientFiles: ['./src/main.tsx'] } },
  // The speech worker's dependencies are listed so Vite bundles them up front instead of reloading the page on first use.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'], include: ['onnxruntime-web/wasm', 'llama-tokenizer-js'] },
});
