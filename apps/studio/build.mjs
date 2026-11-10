// Builds the `saywright` package (npm pack ships bin/ and dist/):
//   dist/client/                     the studio's interface (text files with .br and .gz copies)
//   dist/cli.mjs                     the command and the studio's server in one file, its dependencies included
//   dist/server/speech-worker.mjs    the speech engine's child process, as it is
//   dist/bridge.js                   the script that makes apps pointable, from @saywright/vite
//   dist/axe.min.js                  axe-core (MPL-2.0, unmodified), for the accessibility checks
//   dist/sample/                     the sample shop, copied into the data folder when someone opens it
//   dist/THIRD_PARTY_NOTICES.md      the licences of everything built in
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const plugin = path.resolve(here, '../../packages/vite');
const repo = path.resolve(here, '../..');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const require = createRequire(import.meta.url);

/** Notes the npm packages a build puts in its output (their folders), for the notices. */
const included = new Set();
const collect = () => ({
  name: 'saywright-third-party',
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const id of chunk.moduleIds) {
        const at = id.lastIndexOf(`${path.sep}node_modules${path.sep}`);
        if (at < 0) continue;
        const rest = id.slice(at + 14).split(path.sep);
        included.add(id.slice(0, at + 14) + rest.slice(0, rest[0].startsWith('@') ? 2 : 1).join(path.sep));
      }
    }
  },
});

/**
 * Compressed copies of the interface's text files (file.br, file.gz), which the studio sends to browsers that take them.
 * Not the speech engine's .wasm: its copies would more than double the package, for a file the browser fetches once
 * and keeps.
 */
async function precompress(dir) {
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(html|m?js|css|json|svg|txt)$/i.test(f) && fs.statSync(path.join(dir, f)).size > 1024);
  await Promise.all(
    files.map(async (f) => {
      const file = path.join(dir, f);
      const data = fs.readFileSync(file);
      const [br, gz] = await Promise.all([
        promisify(zlib.brotliCompress)(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
        promisify(zlib.gzip)(data, { level: 9 }),
      ]);
      fs.writeFileSync(`${file}.br`, br);
      fs.writeFileSync(`${file}.gz`, gz);
    }),
  );
}

if (spawnSync(process.execPath, [path.join(plugin, 'build.mjs')], { stdio: 'inherit' }).status !== 0) process.exit(1);
fs.rmSync(dist, { recursive: true, force: true });

await build({
  root: here,
  configFile: path.join(here, 'vite.config.ts'),
  logLevel: 'warn',
  plugins: [collect()],
  build: { outDir: path.join(dist, 'client'), emptyOutDir: true },
});
// Models are downloaded into each person's data folder, never shipped (a checkout may keep old ones in public/).
fs.rmSync(path.join(dist, 'client', 'models'), { recursive: true, force: true });
await precompress(path.join(dist, 'client'));

await build({
  root: here,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  plugins: [collect()],
  // Everything goes in the one file. The speech engine (native, per platform) is an optional dependency instead.
  ssr: { noExternal: true },
  build: {
    ssr: path.join(here, 'cli/index.ts'),
    outDir: dist,
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    rollupOptions: { external: ['sherpa-onnx-node'], output: { format: 'es', entryFileNames: 'cli.mjs', chunkFileNames: 'server/[name]-[hash].mjs' } },
  },
});

fs.mkdirSync(path.join(dist, 'server'), { recursive: true });
fs.copyFileSync(path.join(here, 'server/speech/worker.mjs'), path.join(dist, 'server/speech-worker.mjs'));
fs.copyFileSync(path.join(plugin, 'dist/bridge.js'), path.join(dist, 'bridge.js'));
// The sample shop, as committed (the studio changes it while you try it: npm run reset:sample).
const shop = path.join(repo, 'apps/shop');
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
if (git('status', '--porcelain', '--', 'apps/shop').stdout.trim()) {
  console.error('✗ apps/shop has changes. Run npm run reset:sample, then build again.');
  process.exit(1);
}
for (const file of git('ls-files', '--', 'apps/shop').stdout.split('\n').filter(Boolean)) {
  const to = path.join(dist, 'sample', path.relative(shop, path.join(repo, file)));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(repo, file), to);
}
// On its own: the plugin and Vite from npm, and the TypeScript settings it shared with this repository.
const shopPkg = json(path.join(shop, 'package.json'));
const { dev, test } = shopPkg.scripts;
fs.writeFileSync(
  path.join(dist, 'sample/package.json'),
  JSON.stringify(
    {
      name: 'tidewell-shop',
      version: '1.0.0',
      private: true,
      description: shopPkg.description,
      type: 'module',
      scripts: { dev, test },
      dependencies: shopPkg.dependencies,
      devDependencies: { ...shopPkg.devDependencies, '@saywright/vite': `^${json(path.join(plugin, 'package.json')).version}`, vite: json(path.join(repo, 'package.json')).devDependencies.vite },
    },
    null,
    2,
  ) + '\n',
);
const base = json(path.join(repo, 'tsconfig.base.json'));
const shopTs = json(path.join(shop, 'tsconfig.json'));
fs.writeFileSync(path.join(dist, 'sample/tsconfig.json'), JSON.stringify({ compilerOptions: { ...base.compilerOptions, ...shopTs.compilerOptions }, include: shopTs.include }, null, 2) + '\n');

const axe = require.resolve('axe-core/axe.min.js');
fs.copyFileSync(axe, path.join(dist, 'axe.min.js'));
included.add(path.dirname(axe));

// The web workers' bundles aren't seen by the plugin above: add what the interface's code imports (the workers'
// packages have no dependencies of their own).
const packageDir = (name, from) => {
  for (let dir = from; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) return path.join(dir, 'node_modules', name);
  }
  throw new Error(`${name} isn't installed`);
};
/** Packages the interface's code and styles import (fonts come in through the CSS). */
const imported = (dir) =>
  fs.readdirSync(dir, { recursive: true }).flatMap((file) => {
    if (!/\.(tsx?|css)$/.test(file)) return [];
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    return [...src.matchAll(/^(?:import (?!type )[^'"]*?|@import )['"]([^'"./][^'"]*)['"]/gm)].map((m) => m[1].split('/').slice(0, m[1].startsWith('@') ? 2 : 1).join('/'));
  });
for (const name of new Set(imported(path.join(here, 'src')))) if (!name.startsWith('@/') && !name.startsWith('@shared')) included.add(packageDir(name, here));

const LICENSE_FILES = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
/**
 * A package that ships no licence file still asks for its notice to be kept (MIT and ISC do): the standard text of
 * its licence, with its author. Where the author field isn't the copyright holder, the holder its repository names.
 */
const HOLDER = { 'onnxruntime-web': 'Microsoft Corporation' };
const STANDARD = {
  MIT: (who) => `MIT License\n\nCopyright (c) ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`,
  ISC: (who) => `ISC License\n\nCopyright (c) ${who}\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES\nWITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF\nMERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR\nANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES\nWHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN\nACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF\nOR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};
const authorOf = (pkg) => HOLDER[pkg.name] ?? (typeof pkg.author === 'string' ? pkg.author.replace(/\s*[<(].*$/, '') : pkg.author?.name) ?? `the authors of ${pkg.name}`;
const notices = [...included]
  .map((dir) => ({ dir, pkg: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => pkg.name && !pkg.name.startsWith('@saywright/'))
  .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))
  .filter(({ pkg }, i, all) => i === 0 || all[i - 1].pkg.name !== pkg.name)
  .map(({ dir, pkg }) => {
    const files = fs.readdirSync(dir).filter((f) => LICENSE_FILES.test(f));
    const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see its licence');
    const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n') || (STANDARD[license]?.(authorOf(pkg)) ?? '');
    if (!text) console.warn(`! ${pkg.name} ${pkg.version} ships no licence text, and ${license} has no standard text here`);
    return `## ${pkg.name} ${pkg.version}\n\nLicence: ${license}${pkg.homepage ? ` · ${pkg.homepage}` : ''}\n\n${text ? '```\n' + text + '\n```' : ''}\n`;
  });
fs.writeFileSync(
  path.join(dist, 'THIRD_PARTY_NOTICES.md'),
  `# Third-party notices\n\nSaywright includes the following open-source software, built into its files. Each is used under its own licence, reproduced here.\n\n${notices.join('\n')}\n## Installed beside it\n\nThe optional speech engine, sherpa-onnx-node (Apache-2.0, by the next-gen Kaldi team; https://github.com/k2-fsa/sherpa-onnx), is installed by npm beside the studio as an optional dependency, with its native package for your computer, which includes ONNX Runtime (MIT, Microsoft Corporation). It isn't built into Saywright's files; each comes with its own licence in its package.\n`,
);
console.log(`✓ saywright built (${notices.length} third-party packages noted)`);
