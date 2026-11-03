// Builds the plugin's files:
//   dist/bridge.js                     the browser script injected into the app (no dependencies)
//   dist/index.js                      the Vite plugin (its two dependencies are installed with it)
//   dist/protocol.js, protocol.d.ts    the messages and session events the bridge and the studio exchange
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const r = (p) => path.join(here, p);

await build({
  configFile: false,
  logLevel: 'warn',
  root: here,
  build: {
    outDir: r('dist'),
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: { entry: r('src/bridge/index.ts'), formats: ['es'], fileName: () => 'bridge.js' },
  },
});

await build({
  configFile: false,
  logLevel: 'warn',
  root: here,
  build: {
    outDir: r('dist'),
    emptyOutDir: false,
    minify: false,
    target: 'node20',
    ssr: r('src/index.ts'),
    rollupOptions: {
      external: [/^node:/, 'vite', '@babel/parser', 'magic-string'],
      output: { format: 'es', entryFileNames: 'index.js' },
    },
  },
});

await build({
  configFile: false,
  logLevel: 'warn',
  root: here,
  build: {
    outDir: r('dist'),
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
    lib: { entry: r('src/protocol.ts'), formats: ['es'], fileName: () => 'protocol.js' },
  },
});
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');
if (spawnSync(process.execPath, [tsc, '-p', r('tsconfig.types.json')], { stdio: 'inherit' }).status !== 0) process.exit(1);

console.log('✓ @saywright/vite built');
