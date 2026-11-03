// Runs after `npm install` in this repository: builds the Vite plugin and the script it puts in apps.
// Never breaks the install; `npm run setup` downloads the optional extras (speech models, test browser).
import { spawnSync } from 'node:child_process';
import { c } from './lib/term.mjs';

const build = spawnSync(process.execPath, ['packages/vite/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) console.error(c.red('✗ Could not build @saywright/vite. Run `npm run build:plugin` to see why.'));
