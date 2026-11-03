// Starts a throwaway copy of the sample shop and the studio (with the Claude
// test double) for the end-to-end tests, so they never touch apps/shop.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { ensurePlugin } from '../../../../scripts/lib/plugin.mjs';
import { DATA_DIR } from '../../../../scripts/lib/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(here, '../..');
const SHOP = path.resolve(STUDIO, '../shop');
export const E2E_SHOP = path.join(STUDIO, 'tests/.e2e-shop');
// E2E_STUDIO_PORT / E2E_SHOP_PORT move them, to run suites side by side.
const STUDIO_PORT = Number(process.env.E2E_STUDIO_PORT) || 5273;
const SHOP_PORT = Number(process.env.E2E_SHOP_PORT) || 5274;

// The app gets the bridge as built: test the current sources.
if (!ensurePlugin()) process.exit(1);
fs.rmSync(E2E_SHOP, { recursive: true, force: true });
// Without the sessions and reviews of anyone who used the sample shop in the studio: the tests start from none.
fs.cpSync(SHOP, E2E_SHOP, { recursive: true, filter: (p) => !/node_modules|test-results|[\\/]\.saywright([\\/]|$)|tests[\\/]saywright/.test(p) });
// The copy lives at a different depth, so point its tsconfig back at the shared base config.
const tsconfig = path.join(E2E_SHOP, 'tsconfig.json');
const base = path.relative(E2E_SHOP, path.resolve(STUDIO, '../../tsconfig.base.json')).split(path.sep).join('/');
fs.writeFileSync(tsconfig, fs.readFileSync(tsconfig, 'utf8').replace(/"extends":\s*"[^"]+"/, `"extends": "${base}"`));

process.env.SAYWRIGHT_AI = 'fake';
// The tests' linked apps, settings and usage stay out of yours (speech models are shared: they are large).
process.env.SAYWRIGHT_HOME = path.join(STUDIO, 'tests/.e2e-home');
fs.rmSync(process.env.SAYWRIGHT_HOME, { recursive: true, force: true });
process.env.SAYWRIGHT_SPEECH_DIR ||= path.join(DATA_DIR, 'speech');
// The page's models too (the voice tests use the on-device one).
if (fs.existsSync(path.join(DATA_DIR, 'models'))) {
  fs.mkdirSync(process.env.SAYWRIGHT_HOME, { recursive: true });
  fs.symlinkSync(path.join(DATA_DIR, 'models'), path.join(process.env.SAYWRIGHT_HOME, 'models'), 'junction');
}
const shop = await createServer({ root: E2E_SHOP, configFile: path.join(E2E_SHOP, 'vite.config.ts'), server: { port: SHOP_PORT, strictPort: true, warmup: { clientFiles: ['./src/main.tsx'] } }, logLevel: 'warn', clearScreen: false });
await shop.listen();
process.env.SAYWRIGHT_TARGET_URL = `http://localhost:${SHOP_PORT}/`;
process.env.SAYWRIGHT_TARGET_ROOT = E2E_SHOP;
const studio = await createServer({ root: STUDIO, configFile: path.join(STUDIO, 'vite.config.ts'), server: { port: STUDIO_PORT, strictPort: true }, logLevel: 'warn', clearScreen: false });
await studio.listen();
console.log(`e2e: studio on http://localhost:${STUDIO_PORT}, shop copy on http://localhost:${SHOP_PORT}`);

const stop = async () => {
  await Promise.allSettled([studio.close(), shop.close()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
