/**
 * Reading an app's folder before linking it: its framework, package manager, dev command and address. In a monorepo
 * the app's tools live in the workspace above it (Vite, node_modules, the lockfile), and a lockfile can be stale: the
 * package manager is the one that installed the dependencies, when this computer has it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPort, packageManagerFor, probeFolder, probeUrl } from '../../server/apps/detect';
import { monorepo, programs, tree, VITE_REACT } from './helpers';

let path$: { restore: () => void } | null = null;
/** The package managers this computer has, for one test. */
const installed = (...names: string[]) => (path$ = programs(...names));
afterEach(() => path$?.restore());

describe('the package manager', () => {
  it('is the one that installed node_modules, though another one’s lockfile is there too', () => {
    installed('pnpm');
    const dir = tree({ 'package.json': { name: 'blog', scripts: { dev: 'astro dev' } }, 'pnpm-lock.yaml': '', 'package-lock.json': '{}', 'node_modules/.package-lock.json': '{}' });
    expect(packageManagerFor(dir)).toEqual({ uses: 'npm', runs: 'npm' });
    expect(probeFolder(dir)).toMatchObject({ packageManager: 'npm', start: 'npm run dev' });
  });

  it('is the workspace’s, found above the app', () => {
    installed('yarn');
    expect(packageManagerFor(monorepo().app)).toEqual({ uses: 'yarn', runs: 'yarn' });
  });

  it('runs the app with npm, saying why, when the one it uses isn’t installed on this computer (installs still use it)', () => {
    installed();
    const dir = tree({ 'package.json': { name: 'admin', scripts: { dev: 'vite' } }, 'pnpm-lock.yaml': '', 'node_modules/.modules.yaml': '' });
    const found = packageManagerFor(dir);
    expect(found).toMatchObject({ uses: 'pnpm', runs: 'npm' });
    expect(found.note).toMatch(/It uses pnpm, which isn’t installed on this computer, so it runs with npm/);
    const probe = probeFolder(dir);
    expect(probe).toMatchObject({ packageManager: 'pnpm', start: 'npm run dev' });
    expect(probe.notes).toContain(found.note);
  });

  it('stops at the top of the project: a lockfile above it isn’t the app’s', () => {
    installed('yarn');
    const outside = tree({ 'yarn.lock': '' });
    const app = path.join(outside, 'site');
    fs.mkdirSync(path.join(app, '.git'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'site', scripts: { dev: 'vite' } }));
    expect(packageManagerFor(app)).toEqual({ uses: 'npm', runs: 'npm' });
  });
});

describe('a Vite + React app in a monorepo', () => {
  it('is a Vite app the plugin can go in, with its dependencies installed in the workspace', () => {
    installed('yarn');
    const probe = probeFolder(monorepo().app);
    expect(probe).toMatchObject({ name: 'web', framework: 'vite', packageManager: 'yarn', start: 'yarn start', needsInstall: false, canAddPlugin: true, url: 'http://localhost:5173' });
    // Its port is worked out in code: Vite's usual one, and a note that says so.
    expect(probe.notes.join(' ')).toMatch(/vite\.config\.mts works out its port in code, so 5173/);
  });

  it('at the workspace’s top: the apps inside it, to pick one', () => {
    installed('yarn');
    const { root } = monorepo();
    expect(probeFolder(root).candidates).toEqual([{ name: 'web', path: path.join(root, 'web'), framework: 'vite' }]);
  });
});

describe('the port in a config', () => {
  it('is read when it is written as a number', () => {
    expect(configPort(`export default { server: { host: true, port: 3333, strictPort: false } }`)).toBe(3333);
    expect(configPort(`export default {\n  server: {\n    // the dev server (ours)\n    hmr: { port: 24678 },\n    'port': 3100, // ours\n  },\n  preview: { port: 4173 },\n}`)).toBe(3100);
  });

  it('is unknown (NaN) when it is worked out in code, and null when none is set', () => {
    expect(configPort(VITE_REACT)).toBeNaN();
    expect(configPort(`export default { server: { port: process.env.PORT } }`)).toBeNaN();
    expect(configPort(`export default { plugins: [react()], preview: { port: 4173 } }`)).toBeNull();
    // Vitest's own server block has no port: the app's comes after it.
    expect(configPort(`export default { test: { server: { deps: { inline: ['x'] } } }, server: { port: 5000 } }`)).toBe(5000);
  });

  it('comes from the app’s Vite config when its dev script doesn’t say', () => {
    const dir = tree({ 'package.json': { name: 'admin', scripts: { dev: 'vite' }, devDependencies: { vite: '7' } }, 'vite.config.ts': `export default { server: { hmr: { port: 24678 }, port: 3333 } }` });
    expect(probeFolder(dir).url).toBe('http://localhost:3333');
    const flagged = tree({ 'package.json': { name: 'admin', scripts: { dev: 'vite --port 4000' }, devDependencies: { vite: '7' } }, 'vite.config.ts': `export default { server: { port: 3333 } }` });
    expect(probeFolder(flagged).url).toBe('http://localhost:4000');
  });

  it('comes from an Astro config too', () => {
    const dir = tree({ 'package.json': { name: 'blog', scripts: { dev: 'astro dev' }, dependencies: { astro: '6' } }, 'astro.config.mjs': `export default defineConfig({ server: { port: 4400 } })` });
    expect(probeFolder(dir)).toMatchObject({ framework: 'astro', url: 'http://localhost:4400' });
  });
});

describe('how a folder’s pages reach the studio', () => {
  it('a Next.js app connected with the script tag is shown as it is, not through the proxy', () => {
    installed('npm');
    const tagged = tree({
      'package.json': { name: 'portfolio', scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0', react: '19.0.0' } },
      'app/layout.tsx': `export default function Root({ children }) {\n  return (<html><body>\n        {process.env.NODE_ENV === 'development' && <script src="http://localhost:7357/saywright.js" defer />}\n        {children}</body></html>);\n}\n`,
    });
    expect(probeFolder(tagged)).toMatchObject({ connection: 'script' });
    expect(probeFolder(tagged).notes.join(' ')).toMatch(/without the proxy/);
    const plain = tree({ 'package.json': { name: 'plain', scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0' } }, 'app/layout.tsx': 'export default function Root({ children }) { return <html><body>{children}</body></html>; }\n' });
    expect(probeFolder(plain)).toMatchObject({ connection: 'proxy' });
  });
});

describe('apps that aren’t built with npm alone', () => {
  it('a PHP app: started with PHP’s own server (Laravel’s artisan when it is one), with no packages to install', () => {
    const plain = tree({ 'index.php': '<?php echo "Hi";', 'about.php': '' });
    expect(probeFolder(plain)).toMatchObject({ framework: 'php', start: 'php -S localhost:8000', url: 'http://localhost:8000', needsInstall: false, connection: 'proxy' });
    expect(probeFolder(plain).packageManager).toBeUndefined();
    expect(probeFolder(plain).notes.join(' ')).toMatch(/A PHP app: the studio starts it with php -S localhost:8000/);
    const laravel = tree({ artisan: '', 'composer.json': '{}', 'public/index.php': '', 'package.json': { name: 'shop', scripts: { dev: 'vite' }, devDependencies: { 'laravel-vite-plugin': '1.0.0' } } });
    expect(probeFolder(laravel)).toMatchObject({ framework: 'php', start: 'php artisan serve --port=8000', needsInstall: false });
  });

  it('a folder of pages has no package manager to show', () => {
    expect(probeFolder(tree({ 'index.html': '<title>Notes</title>' }))).toMatchObject({ framework: 'static', start: null });
    expect(probeFolder(tree({ 'index.html': '<title>Notes</title>' })).packageManager).toBeUndefined();
  });

  it('a Vue app is called Vue, not just Vite', () => {
    installed('npm');
    expect(probeFolder(tree({ 'package.json': { name: 'admin', scripts: { dev: 'vite' }, dependencies: { vue: '3.5.0' }, devDependencies: { vite: '7.0.0' } } }))).toMatchObject({ framework: 'vue', url: 'http://localhost:5173', canAddPlugin: false });
  });
});

describe('an app linked by its address', () => {
  const serve = async (title: string) => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => res.setHeader('Content-Type', 'text/html').end(`<!doctype html><title>${title}</title><p>hi</p>`));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as { port: number }).port };
  };

  it('is named by its page’s title, unless the title names the page (“Sign in”): then by its address', async () => {
    for (const [title, named] of [
      ['Ledger | Accounts', 'Ledger'],
      ['Sign in', null],
      ['Vite + React + TS', null],
      ['Dashboard', null],
    ] as const) {
      const { server, port } = await serve(title);
      try {
        expect((await probeUrl(`http://localhost:${port}/`)).name, title).toBe(named ?? `localhost:${port}`);
      } finally {
        server.close();
      }
    }
  });
});
