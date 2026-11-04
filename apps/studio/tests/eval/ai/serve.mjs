// Starts the studio (its sources, with the real AI of your environment) and every benchmark app twice: as written,
// with its bug, and as its bug-free twin. Each copy lives in tests/.eval-work, so the apps' own files never change;
// the studio's data goes to tests/.eval-home, out of yours. Writes where everything runs to .eval-work/apps.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { ensurePlugin } from '../../../../../scripts/lib/plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(here, '../../..');
const APPS = path.join(here, '../apps');
const WORK = path.join(STUDIO, 'tests/.eval-work');
const STUDIO_PORT = Number(process.env.EVAL_STUDIO_PORT) || 5373;
const FIRST_APP_PORT = Number(process.env.EVAL_APP_PORT) || 5401;
const only = (process.env.EVAL_APPS ?? '').split(',').filter(Boolean);

if (!ensurePlugin()) process.exit(1);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.SAYWRIGHT_HOME = path.join(STUDIO, 'tests/.eval-home');
fs.rmSync(process.env.SAYWRIGHT_HOME, { recursive: true, force: true });
// EVAL_DRY=1: the AI test stand-in, to try the benchmark itself at no cost (its numbers mean nothing).
if (process.env.EVAL_DRY) process.env.SAYWRIGHT_AI = 'fake';
else delete process.env.SAYWRIGHT_AI;

const servers = [];
const apps = [];
let port = FIRST_APP_PORT;
for (const name of fs.readdirSync(APPS).filter((n) => !only.length || only.includes(n)).sort()) {
  const bench = JSON.parse(fs.readFileSync(path.join(APPS, name, 'bench.json'), 'utf8'));
  for (const variant of ['bug', 'twin']) {
    const root = path.join(WORK, `${name}-${variant}`);
    fs.cpSync(path.join(APPS, name), root, { recursive: true });
    if (variant === 'twin')
      for (const p of bench.twin) {
        const file = path.join(root, p.file);
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes(p.find)) throw new Error(`${name}: the twin's change doesn't apply to ${p.file}`);
        fs.writeFileSync(file, text.replace(p.find, p.replace));
      }
    const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'warn', clearScreen: false });
    await server.listen();
    servers.push(server);
    apps.push({ name, variant, root, url: `http://localhost:${port}/`, bench });
    port++;
  }
}
fs.writeFileSync(path.join(WORK, 'apps.json'), JSON.stringify(apps, null, 2));

const studio = await createServer({ root: STUDIO, configFile: path.join(STUDIO, 'vite.config.ts'), server: { port: STUDIO_PORT, strictPort: true }, logLevel: 'warn', clearScreen: false });
await studio.listen();
console.log(`eval: studio on http://localhost:${STUDIO_PORT}, ${apps.length} apps from port ${FIRST_APP_PORT}`);

const stop = async () => {
  await Promise.allSettled([studio.close(), ...servers.map((s) => s.close())]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
