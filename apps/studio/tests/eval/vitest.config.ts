import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// The speech evaluation: long-running, needs downloaded data and models, so it's not part of `npm test`.
export default defineConfig({
  root: here,
  test: {
    include: ['**/*.eval.ts'],
    environment: 'node',
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
});
