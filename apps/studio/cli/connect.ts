/**
 * `saywright connect <app folder>`: connect an app to the studio, once.
 *
 *   Vite            adds the @saywright/vite plugin (element ↔ exact source line for React, test sessions), in Vue
 *                   on Vite too; a CommonJS config is left as it is (the plugin is an ES module)
 *   Next.js         adds one development-only script tag to the root layout
 *   Others          with an HTML page (Create React App, webpack, Angular…): the script tag in that page; without one
 *                   (SvelteKit, Astro, Nuxt, Docusaurus…) nothing to add: the studio shows them through its proxy
 *
 * The app is read as the studio reads it (server/apps/detect.ts), so in a monorepo Vite, the dependencies and the
 * package manager are found in the workspace above the app. The studio links the app the next time it starts (from
 * target.json in its data folder) and opens it first.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { STUDIO_URL } from '@saywright/vite/protocol';
import { declaredDeps, devCommandOf, FRAMEWORK_NAME, frameworkOf, htmlTitle, installedPackage, loadsBridge, packageManagerFor, portGuess, readPkg, VITE_BASED, viteConfigIn, workspaceApps } from '../server/apps/detect.ts';
import { diffFile } from '../server/diff.ts';
import { connectedTargets } from '../server/apps/connected.ts';
import { ASSIGNED_URL } from '../server/apps/registry.ts';
import type { CliContext } from './index.ts';
import { addJsxScript, addPageScript, addVitePlugin } from './source.ts';
import { c, fail, warn } from './term.ts';

const HELP = `
${c.bold('saywright connect')} <app folder> [options]: connect an app to the studio, once

  --url <address>        where the app runs (default: what its config says, else its framework's usual address)
  --start "<command>"    the command that starts it (default: its dev script)
  --no-start             you start the app yourself
  --studio <address>     where the studio runs, if not on ${STUDIO_URL} (the script tag loads from it)
  --dry-run              show what would change, change nothing
`;

/** Where the studio that runs now listens, as it wrote when it started: null when none runs. */
export function runningStudio(dataDir: string): string | null {
  let saved: { url?: unknown; pid?: unknown };
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8')) as typeof saved;
  } catch {
    return null;
  }
  if (typeof saved.url !== 'string' || !/^https?:\/\//.test(saved.url) || typeof saved.pid !== 'number') return null;
  try {
    process.kill(saved.pid, 0);
  } catch (err) {
    // Running, as another user: still the studio's address. Gone: the usual one.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  return saved.url;
}

export async function connect(argv: string[], ctx: CliContext): Promise<number> {
  // --no-start answers --start, which takes a command: parseArgs only turns --no-… into "off" for switches.
  const noStart = argv.includes('--no-start');
  const { values, positionals } = parseArgs({
    args: argv.filter((a) => a !== '--no-start'),
    options: { url: { type: 'string' }, start: { type: 'string' }, studio: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    allowNegative: true,
  });
  if (values.help || !positionals[0]) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  const dry = !!values['dry-run'];
  // The studio that runs now, where it said it listens (it may have moved off its usual port), else the usual place.
  const studio = (values.studio ?? runningStudio(ctx.layout.dataDir) ?? STUDIO_URL).replace(/\/+$/, '');
  const scriptUrl = `${studio}/saywright.js`;
  const root = path.resolve(positionals[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`No folder at ${root}.`, 'Point at your app’s folder.');
    return 1;
  }
  const pkg = readPkg(root);
  const framework = frameworkOf(root, pkg);
  // A folder of pages, or a PHP app, needs no package.json: the studio shows it through its proxy.
  if (!pkg && framework !== 'static' && framework !== 'php') {
    fail(`No package.json, index.html or index.php in ${root}.`, 'Point at your app’s folder.');
    return 1;
  }
  const name = pkg?.name ?? htmlTitle(root) ?? path.basename(root);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const first = (...files: string[]) => files.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  // Packages are installed with the app's own package manager; its scripts may run with npm when this computer lacks it.
  const { uses: pm, runs, note: pmNote } = packageManagerFor(root);
  const dev = devCommandOf(root, pkg, runs, framework);
  const viteConfig = VITE_BASED.has(framework) ? viteConfigIn(root) : null;
  const page = first('public/index.html', 'index.html', 'src/index.html');

  // A monorepo's top folder that isn't an app itself: which apps to connect instead, as you would type them.
  const apps = pkg ? workspaceApps(root, pkg) : [];
  if (apps.length && !viteConfig && framework !== 'next' && !page) {
    const folders = apps.map((a) => path.join(positionals[0], path.relative(root, a.path)));
    const width = Math.max(...folders.map((f) => f.length));
    fail(`${name} is a monorepo. Connect the app you work on, with its folder:`, apps.map((a, i) => `${folders[i].padEnd(width)}   ${FRAMEWORK_NAME[a.framework ?? 'other']}`).join('\n  '));
    return 1;
  }

  // What it does, as it says it: “Adds …” before it is done (a dry run), “Added …” once it is.
  const changes: string[] = [];
  const edits: { file: string; before: string; after: string }[] = [];
  const write = (file: string, content: string, what: string) => {
    changes.push(`${dry ? would(what) : what}: ${path.relative(root, file)}`);
    edits.push({ file, before: fs.readFileSync(file, 'utf8'), after: content });
    if (!dry) fs.writeFileSync(file, content);
  };
  /** Run the app's package manager; false (and why) when it fails. */
  const run = (args: string[]): boolean => {
    if (pm !== runs) {
      fail(`${name} installs its packages with ${pm}, which isn’t installed on this computer.`, `Install ${pm} (npm install -g ${pm}), then connect again.`);
      return false;
    }
    if (dry) return true;
    const r = spawnSync(pm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status === 0) return true;
    fail(`${pm} ${args.join(' ')} failed.`, `Run it yourself in ${root}.`);
    return false;
  };
  /** A script tag added before, pointing at another studio address: point it here. */
  const retarget = (file: string, src: string) => {
    const next = src.replace(/https?:\/\/[^"'\s]+\/saywright\.js/g, scriptUrl);
    if (next !== src) write(file, next, `Pointed the Saywright script at ${studio}`);
  };

  let how: 'plugin' | 'script' | 'proxy';
  /** The script tag a page built for production keeps: said here as well as in the comment above it. */
  let shipsTag = false;
  if (viteConfig) {
    how = 'plugin';
    const file = path.basename(viteConfig);
    const before = fs.readFileSync(viteConfig, 'utf8');
    // Where the plugin goes is found before anything is installed: a config it can't go in safely is left as it is.
    const edit = addVitePlugin(before, viteConfig);
    if (edit.kind === 'manual') {
      const byHand = `import saywright from '@saywright/vite';\n  plugins: [saywright(), …your other plugins]`;
      if (edit.commonjs) fail(`${file} is a CommonJS file (require and module.exports), and the Saywright plugin needs an ES module config. ${file} is left as it is.`, `Write the config as an ES module (vite.config.mjs, with import and export default), then add:\n  ${byHand}`);
      else fail(`Couldn’t add the plugin to ${file} safely: ${edit.why}. ${file} is left as it is. Add saywright() to your plugins by hand:`, byHand);
      return 1;
    }
    // The package first: if installing fails, the config isn't left importing a plugin that isn't there. In a
    // monorepo it may be installed for the whole workspace already.
    if (!deps['@saywright/vite'] && !installedPackage(root, '@saywright/vite')) {
      // A folder (this repository's plugin) needs file: for yarn; a published version installs as it is.
      const spec = path.isAbsolute(ctx.pluginSpec) && pm === 'yarn' ? `file:${ctx.pluginSpec}` : ctx.pluginSpec;
      changes.push(`${dry ? 'Installs' : 'Installed'} @saywright/vite with ${pm}`);
      if (!run(pm === 'npm' ? ['install', '-D', spec] : ['add', '-D', spec])) return 1;
    }
    if (edit.kind === 'edit' && edit.code !== before) write(viteConfig, edit.code, edit.repaired ? 'Added the saywright() plugin to the config’s own plugins' : 'Added the saywright() plugin');
  } else if (framework === 'next') {
    how = 'script';
    const layout = first('src/app/layout.tsx', 'app/layout.tsx', 'src/app/layout.jsx', 'app/layout.jsx', 'src/app/layout.js', 'app/layout.js');
    const doc = first('src/pages/_document.tsx', 'pages/_document.tsx', 'src/pages/_document.jsx', 'pages/_document.jsx', 'src/pages/_document.js', 'pages/_document.js');
    const tag = `{process.env.NODE_ENV === 'development' && <script src="${scriptUrl}" defer />}`;
    const file = layout ?? doc;
    if (!file) {
      fail('Found neither app/layout nor pages/_document. Add this to your root layout:', tag);
      return 1;
    }
    const src = fs.readFileSync(file, 'utf8');
    if (loadsBridge(src)) retarget(file, src);
    else {
      const edit = addJsxScript(src, layout ? 'body' : 'head', tag);
      if ('refused' in edit) {
        fail(`Couldn’t add the Saywright script to ${path.relative(root, file)}: ${edit.refused}. It is left as it is. Add this inside your root layout’s ${layout ? '<body>' : '<Head>'}:`, tag);
        return 1;
      }
      if (edit.code !== src) write(file, edit.code, 'Added the Saywright script (development only)');
    }
  } else if (page && framework !== 'static') {
    how = 'script';
    const src = fs.readFileSync(page, 'utf8');
    if (loadsBridge(src)) retarget(page, src);
    else {
      // First in the head, and not deferred: the session recorder is in place before the app's own scripts run, so
      // nothing they do is missed (after a reload too). It only loads where the studio runs (your computer); anywhere
      // else the request fails at once and the page carries on.
      const lines = ['<!-- Saywright (development): remove before you deploy -->', `<script src="${scriptUrl}"></script>`];
      const edit = addPageScript(src, lines);
      if ('refused' in edit) {
        fail(`Couldn’t add the Saywright script to ${path.relative(root, page)}: ${edit.refused}. It is left as it is. Add this first in its <head>:`, lines.join('\n  '));
        return 1;
      }
      write(page, edit.code, 'Added the Saywright script');
      shipsTag = true;
    }
  } else {
    // Pages the framework renders itself (no HTML file to add a tag to), a folder of pages (a tag in one page would
    // leave the others out) or a PHP app: the proxy adds the studio to every page.
    how = 'proxy';
    changes.push('Nothing to add to its code: the studio shows every page through its proxy');
  }

  // A static site has no usual port: it gets its address when it is served, by its start script or by the studio.
  const url = values.url ?? (dev.port ? `http://localhost:${dev.port}` : ASSIGNED_URL);
  const start = noStart ? null : values.start === undefined ? dev.start : values.start || null;
  if (!dry) {
    // Every app connected before the studio next starts is linked then; this one, the last, opens first.
    fs.mkdirSync(ctx.layout.dataDir, { recursive: true });
    const file = path.join(ctx.layout.dataDir, 'target.json');
    const waiting = connectedTargets(file).filter((t) => path.resolve(t.root) !== root);
    fs.writeFileSync(file, JSON.stringify({ targets: [...waiting, { url, root, framework, start, studio }] }, null, 2));
  }

  const react = !!declaredDeps(root).react;
  console.log(dry ? `\n${c.yellow('Dry run')}: connecting ${c.bold(name)} (${FRAMEWORK_NAME[framework]}) would change this, and nothing has changed yet:` : `\n${c.green('✓')} Connected ${c.bold(name)} (${FRAMEWORK_NAME[framework]})`);
  for (const change of changes) console.log(`  ${c.dim('·')} ${change}`);
  const where = url !== ASSIGNED_URL ? `${url}${start ? c.dim(`  (started with “${start}”)`) : c.dim('  (start it yourself)')}` : start ? `started with “${start}”, at the address it prints` : 'served by the studio';
  console.log(`  ${c.dim('·')} App: ${where}`);
  if (dry) for (const e of edits) printDiff(path.relative(root, e.file), e.before, e.after);
  if (start && values.start === undefined && !noStart && pmNote) warn(pmNote);
  if (shipsTag) warn(`The script tag ${dry ? 'would go' : 'is'} in ${path.relative(root, page!)}, which goes into your production build too: remove it before you deploy.`, 'Anywhere the studio isn’t running it fails to load and the page carries on, but a visitor’s browser still asks for it.');
  if (!values.url && dev.guessed) warn(`${portGuess(dev.guessed, framework, dev.port)}.`, start ? 'The studio finds the real one when it starts the app.' : 'Connect it again with --url and the address it runs at.');
  const mapping =
    framework === 'static' || framework === 'php'
      ? ' Elements are found in its pages’ code by what they show and their attributes.'
      : how === 'plugin'
        ? react
          ? ''
          : ' Elements map to source through the framework’s development info.'
        : react
          ? ' Elements map to source through React’s development info; for exact lines, use Vite with the plugin.'
          : ' Elements map to source through the framework’s development info.';
  if (dry) {
    console.log(c.dim(`\nRun it again without --dry-run to make ${edits.length || changes.length ? 'these changes' : 'the connection'}.\n`));
    return 0;
  }
  console.log(`\nNext: ${c.cyan(ctx.startCommand)}.${mapping}`);
  const undo = { plugin: ' and remove saywright() from your Vite config', script: ' and remove the saywright.js script tag', proxy: '' }[how];
  console.log(c.dim(`It opens first next time the studio starts, and stays in its app list. To disconnect: remove it from the app list${undo}.\n`));
  return 0;
}

/** “Added the plugin” as said before it is done: “Adds the plugin”. */
function would(done: string): string {
  return done.replace(/^(Added|Pointed|Installed)\b/, (w) => ({ Added: 'Adds', Pointed: 'Points', Installed: 'Installs' })[w as 'Added' | 'Pointed' | 'Installed']);
}

/** The lines a change would add and remove, around where they are. */
function printDiff(file: string, before: string, after: string): void {
  console.log(`\n  ${c.bold(file)}`);
  for (const h of diffFile(file, before, after, 1).hunks) {
    for (const l of h.lines) console.log(l.type === 'add' ? c.green(`  + ${l.text}`) : l.type === 'del' ? c.red(`  - ${l.text}`) : c.dim(`    ${l.text}`));
  }
}
