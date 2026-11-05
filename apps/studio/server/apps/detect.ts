/**
 * What an app is, before linking it: from its folder (framework, package
 * manager, dev command, usual address, whether the Vite plugin is in) or from
 * a URL (what answers there, whether it can be shown in a frame).
 *
 * In a monorepo an app's tools often live in the workspace above it (Vite,
 * node_modules, the lockfile): they are looked for up to the project's top.
 * `saywright connect` reads apps with the same functions, so the two agree.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppProbe, Connection, FolderListing, Framework, PackageManager } from '../../shared/apps.ts';

interface Pkg {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

export function readPkg(dir: string): Pkg | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Pkg;
  } catch {
    return null;
  }
}

const first = (dir: string, ...files: string[]) => files.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) ?? null;
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
/** The studio's script tag in a page, and the Vite plugin's package in a config. */
const BRIDGE_SCRIPT = /\/saywright\.js\b/;
const PLUGIN_PACKAGE = /@saywright\/vite\b/;
const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js'];

/** The app's Vite config file, if it has one. */
export const viteConfigIn = (dir: string) => first(dir, ...VITE_CONFIGS);

export const FRAMEWORK_NAME: Record<Framework, string> = {
  vite: 'Vite',
  vue: 'Vue',
  next: 'Next.js',
  cra: 'Create React App',
  astro: 'Astro',
  remix: 'Remix',
  'react-router': 'React Router',
  sveltekit: 'SvelteKit',
  nuxt: 'Nuxt',
  angular: 'Angular',
  gatsby: 'Gatsby',
  php: 'PHP',
  static: 'static site',
  other: 'web app',
};

const isWorkspaceTop = (dir: string) => fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || !!readPkg(dir)?.workspaces;

/**
 * `dir` and the folders above it, up to the top of its project: the first that is a repository (.git) or a workspace
 * (workspaces in package.json, pnpm-workspace.yaml). Never the home folder or above; six folders at most.
 */
function projectDirs(dir: string): string[] {
  const home = os.homedir();
  const out: string[] = [];
  for (let d = path.resolve(dir); out.length < 6; ) {
    if (d === home && out.length) break;
    out.push(d);
    if (fs.existsSync(path.join(d, '.git')) || isWorkspaceTop(d)) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/** The app's folder and its workspace's top, when it is in one: where its dependencies are installed. */
function installDirs(dir: string): string[] {
  const dirs = projectDirs(dir);
  const top = dirs.slice(1).find(isWorkspaceTop);
  return top ? [dirs[0], top] : [dirs[0]];
}

/** Whether the app's dependencies are installed: in its folder, or for its whole workspace. */
export function dependenciesInstalled(dir: string): boolean {
  return installDirs(dir).some((d) => fs.existsSync(path.join(d, 'node_modules')) || fs.existsSync(path.join(d, '.pnp.cjs')));
}

/** What the app's package.json and its workspace's declare, together (shared tools often sit at the top). */
export function declaredDeps(dir: string): Record<string, string> {
  return Object.assign({}, ...installDirs(dir).reverse().map((d) => ({ ...readPkg(d)?.devDependencies, ...readPkg(d)?.dependencies })));
}

/** Where a package is installed for the app: its folder in the nearest node_modules up to the project's top. */
export function installedPackage(dir: string, name: string): string | null {
  for (const d of projectDirs(dir)) {
    const p = path.join(d, 'node_modules', name);
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
  }
  return null;
}

/** Whether a program can be run by name, as the dev servers the studio starts would find it. */
function onPath(command: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const runnable = (file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => !!d && exts.some((ext) => runnable(path.join(d, command + ext))));
}

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** The package manager that installed the nearest dependencies, from what it leaves in node_modules. */
function installedWith(dirs: string[]): PackageManager | null {
  for (const d of dirs) {
    const has = (name: string) => fs.existsSync(path.join(d, 'node_modules', name));
    if (has('.modules.yaml') || has('.pnpm')) return 'pnpm';
    if (has('.yarn-integrity') || has('.yarn-state.yml') || fs.existsSync(path.join(d, '.pnp.cjs'))) return 'yarn';
    if (has('.package-lock.json')) return 'npm';
  }
  return null;
}

/** The package manager the project asks for: the nearest packageManager field or lockfile. */
function declaredBy(dirs: string[]): PackageManager | null {
  for (const d of dirs) {
    const declared = /^(npm|pnpm|yarn|bun)@/.exec(readPkg(d)?.packageManager ?? '')?.[1] as PackageManager | undefined;
    if (declared) return declared;
    const lock = LOCKFILES.find(([file]) => fs.existsSync(path.join(d, file)));
    if (lock) return lock[1];
  }
  return null;
}

/**
 * The app's package manager: the one that installed its dependencies (a lockfile can be another manager's, left in
 * the repository), else the one its workspace asks for. It installs packages (`uses`); its scripts run with it too
 * when this computer has it, else with npm, which comes with Node (`runs`, and a note saying why).
 */
export function packageManagerFor(dir: string): { uses: PackageManager; runs: PackageManager; note?: string } {
  const dirs = projectDirs(dir);
  const uses = installedWith(dirs) ?? declaredBy(dirs) ?? 'npm';
  if (uses === 'npm' || onPath(uses)) return { uses, runs: uses };
  return { uses, runs: 'npm', note: `It uses ${uses}, which isn’t installed on this computer, so it runs with npm. To install its packages, install ${uses} (npm install -g ${uses}).` };
}

/** Frameworks built on Vite whose pages Vite's HTML hooks reach: the plugin works in them. */
export const VITE_BASED = new Set<Framework>(['vite', 'react-router', 'remix']);

/** Said when a config works out its port in code: the usual port is a guess until the app says where it listens. */
export const portGuess = (config: string, framework: Framework, port: number | null) => `${config} works out its port in code, so ${port} (${FRAMEWORK_NAME[framework]}’s usual one) is a guess`;

const portNote = (config: string, framework: Framework, port: number | null) => `${portGuess(config, framework, port)}: the studio finds the real one when it starts the app.`;

/** The framework, from its dependencies (most specific first). */
export function frameworkOf(dir: string, pkg: Pkg | null): Framework {
  // A PHP app (a page of its own, or Composer's), whatever front-end tooling sits beside it.
  const php = !!first(dir, 'index.php', 'artisan', 'public/index.php') || (!!first(dir, 'composer.json') && !pkg);
  if (!pkg) return php ? 'php' : fs.existsSync(path.join(dir, 'index.html')) ? 'static' : 'other';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.nuxt) return 'nuxt';
  if (deps.astro) return 'astro';
  if (deps['@react-router/dev']) return 'react-router';
  if (deps['@remix-run/dev']) return 'remix';
  if (deps['@angular/core'] && fs.existsSync(path.join(dir, 'angular.json'))) return 'angular';
  if (deps.gatsby) return 'gatsby';
  if (deps['react-scripts']) return 'cra';
  if (php && !deps.vite) return 'php';
  if ((deps.vite || first(dir, ...VITE_CONFIGS)) && deps.vue) return 'vue';
  if (deps.vite || first(dir, ...VITE_CONFIGS)) return 'vite';
  return fs.existsSync(path.join(dir, 'index.html')) ? 'static' : 'other';
}

const DEFAULT_PORT: Record<Framework, number> = {
  vite: 5173,
  vue: 5173,
  next: 3000,
  cra: 3000,
  astro: 4321,
  remix: 5173,
  'react-router': 5173,
  sveltekit: 5173,
  nuxt: 3000,
  angular: 4200,
  gatsby: 8000,
  php: 8000,
  static: 0,
  other: 3000,
};

/**
 * The port a Vite or Astro config gives its dev server (`server: { port: 3000 }`): a number, null when it gives none,
 * NaN when it is worked out in code (from an environment variable…) and can't be read here.
 */
export function configPort(src: string): number | null {
  // Line comments go (not the // in an address), so their brackets don't count.
  const code = src.replace(/(^|\s)\/\/[^\n]*/g, '$1');
  for (const m of code.matchAll(/\bserver\s*:\s*\{/g)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') {
        if (--depth === 0) break;
      } else if (depth === 1 && ch === 'p' && !/[\w$]/.test(code[i - 1])) {
        const value = /^port['"]?\s*:\s*([^,}\n]*)/.exec(code.slice(i, i + 200))?.[1].trim();
        if (value !== undefined) return /^\d{2,5}$/.test(value) ? Number(value) : NaN;
      }
    }
  }
  return null;
}

/**
 * The dev command, and the port it uses: from the script's flags, the Vite or Astro config, or the framework's usual
 * one. `guessed` names the config when it works out the port in code (so the usual one may be wrong).
 */
export function devCommandOf(dir: string, pkg: Pkg | null, pm: PackageManager, framework: Framework): { start: string | null; port: number | null; guessed?: string } {
  // PHP's own server (Laravel's, when it is one): its pages, at the usual port.
  if (framework === 'php') {
    const start = first(dir, 'artisan') ? 'php artisan serve --port=8000' : first(dir, 'index.php') ? 'php -S localhost:8000' : first(dir, 'public/index.php') ? 'php -S localhost:8000 -t public' : null;
    return { start, port: 8000 };
  }
  const scripts = pkg?.scripts ?? {};
  const name = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : scripts.develop ? 'develop' : null;
  const start = name ? (pm === 'npm' ? (name === 'start' ? 'npm start' : `npm run ${name}`) : `${pm} ${name === 'start' ? 'start' : `run ${name}`}`) : null;
  const script = name ? scripts[name] : '';
  const flag = /(?:--port[ =]|-p\s+)(\d{2,5})\b/.exec(script);
  let port = flag ? Number(flag[1]) : null;
  let guessed: string | undefined;
  const config = port ? null : framework === 'astro' ? first(dir, ...ASTRO_CONFIGS) : /vite|vue|react-router|remix|sveltekit/.test(framework) ? first(dir, ...VITE_CONFIGS) : null;
  if (config) {
    const set = configPort(fs.readFileSync(config, 'utf8'));
    if (set) port = set;
    else if (Number.isNaN(set)) guessed = path.basename(config);
  }
  if (!port && /PORT=(\d{2,5})/.test(script)) port = Number(/PORT=(\d{2,5})/.exec(script)![1]);
  if (port) guessed = undefined;
  return { start, port: port ?? (DEFAULT_PORT[framework] || null), ...(guessed ? { guessed } : {}) };
}

function gitRemote(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

/** Apps inside a monorepo's workspaces (apps/*, packages/*…), to pick one. */
export function workspaceApps(dir: string, pkg: Pkg | null): NonNullable<AppProbe['candidates']> {
  const globs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : (pkg?.workspaces?.packages ?? []);
  const pnpm = first(dir, 'pnpm-workspace.yaml');
  if (pnpm) for (const m of fs.readFileSync(pnpm, 'utf8').matchAll(/^\s*-\s*['"]?([^'"\n#]+)['"]?/gm)) globs.push(m[1].trim());
  const out: NonNullable<AppProbe['candidates']> = [];
  for (const g of globs) {
    const base = g.replace(/\/\*+$/, '');
    if (base.includes('*')) continue;
    const parent = path.join(dir, base);
    const dirs = g.endsWith('*') ? safeDirs(parent).map((n) => path.join(parent, n)) : [parent];
    for (const d of dirs) {
      const p = readPkg(d);
      if (!p?.scripts || !(p.scripts.dev || p.scripts.start)) continue;
      const framework = frameworkOf(d, p);
      if (framework === 'other' && !p.scripts.dev) continue;
      out.push({ name: p.name ?? path.basename(d), path: d, framework });
    }
  }
  return out.slice(0, 20);
}

function safeDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Where `connect` adds the studio's script tag (and where a person would): a root layout, a document, the page. */
const SCRIPT_FILES = ['src/app/layout.tsx', 'app/layout.tsx', 'src/app/layout.jsx', 'app/layout.jsx', 'src/app/layout.js', 'app/layout.js', 'src/pages/_document.tsx', 'pages/_document.tsx', 'src/pages/_document.jsx', 'pages/_document.jsx', 'src/pages/_document.js', 'pages/_document.js', 'public/index.html', 'index.html', 'src/index.html'];

/** Whether the app's own pages load the studio's script (connected with its script tag): no proxy needed. */
export function hasScriptTag(dir: string): boolean {
  for (const rel of SCRIPT_FILES) {
    try {
      if (BRIDGE_SCRIPT.test(fs.readFileSync(path.join(dir, rel), 'utf8').slice(0, 200_000))) return true;
    } catch {
      /* not there */
    }
  }
  return false;
}

/** Whether a Vite config already loads the studio's plugin. */
export function hasPlugin(dir: string): boolean {
  const config = first(dir, ...VITE_CONFIGS);
  if (!config) return false;
  const src = fs.readFileSync(config, 'utf8');
  return PLUGIN_PACKAGE.test(src);
}

/** A static site's name: its home page's title, up to the first separator ("Shop | Brand" → "Shop"). */
export function htmlTitle(dir: string): string | null {
  try {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').slice(0, 20_000);
    const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim();
    return title ? title.split(/\s[|–—·-]\s/)[0].trim() : null;
  } catch {
    return null;
  }
}

export function probeFolder(input: string): AppProbe {
  const root = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`No folder at ${root}`);
  const pkg = readPkg(root);
  const framework = frameworkOf(root, pkg);
  const { uses, runs, note: pmNote } = packageManagerFor(root);
  const notes: string[] = [];
  const { start, port, guessed } = devCommandOf(root, pkg, runs, framework);
  const plugin = hasPlugin(root);
  const script = !plugin && hasScriptTag(root);
  const canAddPlugin = VITE_BASED.has(framework) && !plugin && !!declaredDeps(root).react;
  const candidates = pkg ? workspaceApps(root, pkg) : undefined;
  if (!pkg && framework === 'static') notes.push('No package.json: the studio serves this folder as a static site.');
  if (framework === 'php') notes.push(start ? `A PHP app: the studio starts it with ${start} (change it for your own server), and shows it through its proxy.` : 'A PHP app: start it as you usually do, and give its address.');
  if (!pkg && framework === 'other') notes.push('No package.json, index.html or index.php here. Pick the folder of a web app.');
  if (pkg && !start && framework !== 'static' && framework !== 'php') notes.push('No dev, start or serve script: start the app yourself and give its address.');
  if (candidates?.length && !start) notes.push(`A monorepo with ${candidates.length} app${candidates.length === 1 ? '' : 's'}: pick one.`);
  if (canAddPlugin) notes.push('A Vite + React app: adding the Saywright plugin maps every element to its exact line of code.');
  else if (script) notes.push('Its pages load the studio’s script: shown as it is, without the proxy.');
  else if (!plugin && pkg) notes.push('Shown through the studio’s proxy: no change to your code needed.');
  if (start && pmNote) notes.push(pmNote);
  if (start && guessed) notes.push(portNote(guessed, framework, port));
  const needsInstall = !!pkg && !!start && framework !== 'php' && !dependenciesInstalled(root);
  if (needsInstall) notes.push(`Dependencies aren’t installed yet (${uses} install).`);
  return {
    name: (pkg?.name ?? htmlTitle(root) ?? path.basename(root)).replace(/^@[^/]+\//, ''),
    root,
    framework,
    // Packages to install only with a package.json: a folder of pages or a PHP app has none.
    ...(pkg ? { packageManager: uses } : {}),
    start: framework === 'static' && !start ? null : start,
    url: port ? `http://localhost:${port}` : undefined,
    needsInstall,
    plugin,
    canAddPlugin,
    connection: plugin ? 'plugin' : script ? 'script' : 'proxy',
    repo: fs.existsSync(path.join(root, '.git')) ? gitRemote(root) : undefined,
    notes,
    candidates: candidates?.length ? candidates : undefined,
  };
}

export const isLocalHost = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0)$/.test(host) || host.endsWith('.localhost');

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/** A small icon as a data: URL (null when there is none or it is large). */
async function fetchIcon(pageUrl: string, html: string): Promise<string | undefined> {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /\brel\s*=\s*["']?[^"'>]*icon/i.test(t));
  const href = links.map((t) => attr(t, 'href')).find(Boolean) ?? '/favicon.ico';
  try {
    if (href.startsWith('data:')) return href.length < 40_000 ? href : undefined;
    const res = await fetch(new URL(href, pageUrl), { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return undefined;
    const type = (res.headers.get('content-type') ?? '').split(';')[0] || 'image/x-icon';
    if (!/^image\//.test(type)) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 30_000 || !buf.length) return undefined;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Titles that name a page, not an app (or a starter template's). */
const GENERIC_TITLE = /^(?:(?:sign|log)\s?(?:in|on|up)|login|register|home|dashboard|welcome|loading(?:\.{3}|…)?|untitled|index|document|app|my app|react app|vite \+ (?:react|vue|svelte|preact|lit)(?: \+ ts)?|vite app|next(?:\.js)? app|nuxt app|angular(?:app)?|error|404(?: not found)?|not found|page not found)$/i;

/** What answers at a URL: its title and icon, and how the studio can show it. */
export async function probeUrl(input: string): Promise<AppProbe> {
  const raw = input.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `${isLocalHost(raw.split(/[:/]/)[0]) ? 'http' : 'https'}://${raw}`);
  const notes: string[] = [];
  const local = isLocalHost(url.hostname);
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (Saywright link check)' } });
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'didn’t answer within 8 seconds' : 'isn’t reachable';
    throw new Error(local ? `${url.origin} ${why}. Start the app first, or link its folder and the studio starts it.` : `${url.origin} ${why}.`);
  }
  const final = new URL(res.url || url.href);
  const html = /html/i.test(res.headers.get('content-type') ?? '') ? (await res.text()).slice(0, 400_000) : '';
  const title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(html)?.[1]?.trim().replace(/\s+/g, ' ');
  if (!res.ok) notes.push(`It answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
  if (final.origin !== url.origin) notes.push(`It redirects to ${final.origin}.`);
  const frameBlocked = /deny|sameorigin/i.test(res.headers.get('x-frame-options') ?? '') || /frame-ancestors/i.test(res.headers.get('content-security-policy') ?? '');
  // The plugin answers on the app's own dev server.
  let plugin = false;
  if (local) {
    plugin = await fetch(new URL('/__saywright/info', final), { signal: AbortSignal.timeout(2500) })
      .then((r) => r.ok && /json/.test(r.headers.get('content-type') ?? ''))
      .catch(() => false);
  }
  const script = BRIDGE_SCRIPT.test(html);
  const connection: Connection = plugin ? 'plugin' : script ? 'script' : 'proxy';
  if (connection === 'proxy') notes.push(frameBlocked ? 'It refuses to be shown in a frame; the studio’s proxy takes care of that.' : 'Shown through the studio’s proxy, which adds the studio to its pages.');
  if (!local) notes.push('A deployed site: test sessions, replays and audits work; code changes need its folder linked too.');
  // A page's title names the app unless it names the page (“Sign in”, “Dashboard”): then its address does.
  const named = title?.split(/\s[|–—-]\s/)[0]?.trim();
  return {
    name: named && !GENERIC_TITLE.test(named) ? named : final.port ? `${final.hostname}:${final.port}` : final.hostname,
    root: null,
    url: final.origin + (final.pathname === '/' ? '' : final.pathname),
    connection,
    plugin,
    title,
    icon: html ? await fetchIcon(final.href, html) : undefined,
    notes,
  };
}

/** Folders under `dir`, for picking an app's folder (apps marked). */
export function listFolders(dir?: string): FolderListing {
  const home = os.homedir();
  const at = path.resolve((dir || home).replace(/^~(?=$|\/)/, home));
  const entries = safeDirs(at)
    .filter((n) => !/^(Library|Applications|System|proc|sys|dev|snap)$/.test(n))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 400);
  const places = [
    { label: 'Home', path: home },
    ...['Desktop', 'Documents', 'Projects', 'projects', 'code', 'Code', 'dev', 'src', 'workspace', 'repos', 'GitHub', 'saywright-apps']
      .map((n) => ({ label: n, path: path.join(home, n) }))
      .filter((p) => fs.existsSync(p.path)),
  ];
  const parent = path.dirname(at);
  return {
    path: at,
    parent: parent === at ? null : parent,
    folders: entries.map((name) => {
      const p = path.join(at, name);
      return { name, path: p, app: ['package.json', 'index.html', 'index.php', 'composer.json'].some((f) => fs.existsSync(path.join(p, f))) };
    }),
    places,
  };
}
