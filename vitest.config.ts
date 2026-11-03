import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': path.join(here, 'apps/studio/shared'), '@': path.join(here, 'apps/studio/src') },
    // The plugin's protocol and session client from their sources, as the studio uses them.
    conditions: ['source', ...defaultClientConditions],
  },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    environment: 'node',
    testTimeout: 15_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/unit/**/*.test.ts'] } },
      // The on-device speech engine with its real models (skipped when they aren't installed). It measures speed,
      // so it runs on its own: `npm run test:speech`.
      { extends: true, test: { name: 'speech', include: ['apps/studio/tests/speech/**/*.test.ts'], testTimeout: 60_000 } },
    ],
  },
});
