import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { STUDIO_PORT } from '@saywright/vite/protocol';
import { defaultClientConditions, defineConfig } from 'vite';
import { studioApi } from './server/index.ts';
import { repoLayout } from './server/layout.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [react(), tailwindcss(), studioApi(repoLayout(path.resolve(here, '../..')))],
  resolve: {
    alias: { '@': path.resolve(here, 'src'), '@shared': path.resolve(here, 'shared') },
    // The plugin's protocol and session client from their sources (published, the protocol comes built).
    conditions: ['source', ...defaultClientConditions],
  },
  // Pre-transform the app on start, so the first page load is quick.
  server: { port: STUDIO_PORT, warmup: { clientFiles: ['./src/main.tsx'] } },
  // The speech worker's dependencies are listed so Vite bundles them up front instead of reloading the page on first use.
  optimizeDeps: { include: ['onnxruntime-web/wasm', 'llama-tokenizer-js'] },
});
