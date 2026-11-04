/**
 * The `saywright` command: its help and version, how it explains a mistake, and `connect` on apps of each kind
 * (with --dry-run, nothing is written; without it, the app's config gets the plugin and the studio is told), in a
 * monorepo too, where it finds what the studio finds.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type CliContext } from '../../cli/index';
import { probeFolder } from '../../server/apps/detect';
import { announce, createStudioApi, studioRoutes } from '../../server/index';
import { repoLayout } from '../../server/layout';
import { MODELS } from '../../server/speech/catalog';
import { SpeechService } from '../../server/speech/service';
import { dispatch } from '../../server/standalone';
import { monorepo, programs, tree } from './helpers';

const ROOT = path.resolve(__dirname, '../../../..');
let out: string[] = [];
let ctx: CliContext;

beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-cli-'));
  // The plugin is already installed in the apps below, so connect never runs a package manager.
  ctx = { layout: { ...repoLayout(ROOT), dataDir: data, envDir: data }, clientDir: null, pluginSpec: '@saywright/vite@^0.1.0', startCommand: 'npx @saywright/studio' };
});
let path$: { restore: () => void } | null = null;
/** The package managers this computer has, for one test. */
const installed = (...names: string[]) => (path$ = programs(...names));
afterEach(() => {
  vi.restoreAllMocks();
  path$?.restore();
  path$ = null;
});

function app(files: Record<string, string>, deps: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-app-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-app', scripts: { dev: 'vite' }, devDependencies: deps }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

describe('the command', () => {
  it('prints its version and help', async () => {
    expect(await main(['--version'], ctx)).toBe(0);
    expect(out.join('\n')).toBe(ctx.layout.version);
    out = [];
    expect(await main(['--help'], ctx)).toBe(0);
    expect(out.join('\n')).toMatch(/saywright connect/);
    // The test browser comes with a checkout of the repository only.
    expect(out.join('\n')).toMatch(/saywright setup\s+download the optional extras: voice and speech models$/m);
  });

  it('explains an unknown command or option, and fails', async () => {
    expect(await main(['deploy'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/No command “deploy”/);
    out = [];
    expect(await main(['connect', '--colour'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/--colour/);
  });

  it('won’t start without the built interface (in the repository, Vite serves it)', async () => {
    expect(await main(['--no-open'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/npm run dev/);
  });
});

describe('every option a help text shows', () => {
  /** The options a help text lists (each line's first, or in [brackets]), with a value when one is shown. */
  const optionsIn = (help: string) => [...help.matchAll(/(?:^\s*|\[)(--[a-z][\w-]*)(?: ("?<[^>]+>"?|\d+))?/gm)].map((m) => [m[1], ...(m[2] ? [m[2]] : [])]);

  it.each(['start', 'connect', 'setup', 'doctor', 'mcp'])('saywright %s: each one is understood', async (command) => {
    expect(await main([command, '--help'], ctx)).toBe(0);
    const options = optionsIn(out.join('\n'));
    if (command !== 'doctor' && command !== 'mcp') expect(options.length).toBeGreaterThan(1);
    for (const option of options) {
      out = [];
      const args = [command, ...option, '--help'];
      expect(await main(args, ctx), `saywright ${args.join(' ')}\n${out.join('\n')}`).toBe(0);
    }
  });

  it('saywright: the options the main help shows', async () => {
    expect(await main(['--help'], ctx)).toBe(0);
    const options = optionsIn(out.join('\n')).filter(([o]) => o !== '--help');
    expect(options.map(([o]) => o)).toEqual(['--port', '--no-open']);
    for (const option of options) {
      out = [];
      expect(await main([...option, '--help'], ctx), out.join('\n')).toBe(0);
    }
  });
});

describe('connect', () => {
  const VITE = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`;

  it('changes nothing with --dry-run, and says what it would do', async () => {
    const dir = app({ 'vite.config.ts': VITE }, { vite: '^8', '@saywright/vite': '^0.1.0' });
    expect(await main(['connect', dir, '--dry-run'], ctx)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')).toBe(VITE);
    expect(fs.existsSync(path.join(ctx.layout.dataDir, 'target.json'))).toBe(false);
    expect(out.join('\n')).toMatch(/Added the saywright\(\) plugin: vite.config.ts/);
  });

  it('adds the plugin to a Vite app and tells the studio to open it', async () => {
    const dir = app({ 'vite.config.ts': VITE }, { vite: '^8', '@saywright/vite': '^0.1.0' });
    expect(await main(['connect', dir, '--url', 'http://localhost:5180'], ctx)).toBe(0);
    const config = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
    expect(config).toContain(`import saywright from '@saywright/vite';`);
    expect(config).toContain('plugins: [saywright(), react()]');
    expect(JSON.parse(fs.readFileSync(path.join(ctx.layout.dataDir, 'target.json'), 'utf8'))).toMatchObject({ url: 'http://localhost:5180', root: dir, framework: 'vite', start: 'npm run dev' });
    // Twice is the same as once.
    expect(await main(['connect', dir], ctx)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')).toBe(config);
  });

  it('with --no-start, tells the studio you start the app yourself', async () => {
    const dir = app({ 'vite.config.ts': VITE }, { vite: '^8', '@saywright/vite': '^0.1.0' });
    expect(await main(['connect', dir, '--no-start', '--url', 'http://localhost:5180'], ctx)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(ctx.layout.dataDir, 'target.json'), 'utf8'))).toMatchObject({ url: 'http://localhost:5180', start: null });
    expect(out.join('\n')).toMatch(/App: http:\/\/localhost:5180\s+\(start it yourself\)/);
  });

  it('adds the plugin in the config’s own style: its quotes, one plugin a line', async () => {
    const config = `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [\n    react(),\n  ],\n});\n`;
    const dir = app({ 'vite.config.ts': config }, { vite: '^8', '@saywright/vite': '^0.1.0' });
    expect(await main(['connect', dir], ctx)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')).toBe(`import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport saywright from "@saywright/vite";\n\nexport default defineConfig({\n  plugins: [\n    saywright(),\n    react(),\n  ],\n});\n`);
  });

  it('adds a development-only script tag to a Next.js layout, pointing at the studio', async () => {
    const dir = app({ 'app/layout.tsx': `export default function Root({ children }) {\n  return <html><body>{children}</body></html>;\n}\n` }, { next: '^16' });
    expect(await main(['connect', dir], ctx)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'app/layout.tsx'), 'utf8')).toContain(`{process.env.NODE_ENV === 'development' && <script src="http://localhost:7357/saywright.js" defer />}`);
  });

  it('points the script tag at the studio that runs now, wherever it moved, and at the usual place once it stops', async () => {
    const layout = `export default function Root({ children }) {\n  return <html><body>{children}</body></html>;\n}\n`;
    const dir = app({ 'app/layout.tsx': layout }, { next: '^16' });
    // This process stands for a studio that started on 7440, its usual port being taken.
    fs.writeFileSync(path.join(ctx.layout.dataDir, 'server.json'), JSON.stringify({ url: 'http://localhost:7440', pid: process.pid }));
    expect(await main(['connect', dir], ctx)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'app/layout.tsx'), 'utf8')).toContain('<script src="http://localhost:7440/saywright.js" defer />');
    const gone = app({ 'app/layout.tsx': layout }, { next: '^16' });
    fs.writeFileSync(path.join(ctx.layout.dataDir, 'server.json'), JSON.stringify({ url: 'http://localhost:7440', pid: 2 ** 22 + 12345 }));
    expect(await main(['connect', gone], ctx)).toBe(0);
    expect(fs.readFileSync(path.join(gone, 'app/layout.tsx'), 'utf8')).toContain('<script src="http://localhost:7357/saywright.js" defer />');
  });

  it('points a script tag added before, for a studio at another address, at this one', async () => {
    const dir = app({ 'public/index.html': `<html><head>\n<!-- Saywright (development): remove before you deploy -->\n<script src="http://localhost:5173/saywright.js"></script></head></html>` }, { 'react-scripts': '5' });
    expect(await main(['connect', dir], ctx)).toBe(0);
    const html = fs.readFileSync(path.join(dir, 'public/index.html'), 'utf8');
    expect(html).toContain('<script src="http://localhost:7357/saywright.js"></script>');
    expect(html.match(/saywright\.js/g)).toHaveLength(1);
  });

  it('refuses a folder that isn’t an app', async () => {
    expect(await main(['connect', fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/No package.json/);
  });
});

describe('connect, as the studio reads apps', () => {
  const target = () => JSON.parse(fs.readFileSync(path.join(ctx.layout.dataDir, 'target.json'), 'utf8')) as Record<string, unknown>;

  it('finds a Vite + React app in a monorepo, with Vite and yarn in the workspace above it', async () => {
    installed('yarn');
    const { app } = monorepo();
    expect(await main(['connect', app, '--dry-run'], ctx)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/Connected web \(Vite\)/);
    expect(text).toMatch(/Added the saywright\(\) plugin: vite\.config\.mts/);
    expect(text).toMatch(/Installed @saywright\/vite with yarn/);
    expect(text).toMatch(/App: http:\/\/localhost:5173\s+\(started with “yarn start”\)/);
    expect(text).toMatch(/vite\.config\.mts works out its port in code, so 5173 \(Vite’s usual one\) is a guess/);
  });

  it('at a monorepo’s top, says which of its apps to connect', async () => {
    installed('yarn');
    const { root } = monorepo();
    expect(await main(['connect', root], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/shapes-monorepo is a monorepo/);
    // Each app as you would type it: here, the folder given, then the app's place in it.
    const folder = path.join(root, 'web').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(out.join('\n')).toMatch(new RegExp(`^\\s*${folder}\\s+Vite$`, 'm'));
    expect(fs.existsSync(path.join(ctx.layout.dataDir, 'target.json'))).toBe(false);
  });

  it('tells the studio what the studio itself finds', async () => {
    installed('yarn');
    // The plugin is installed for the whole workspace already: nothing to install.
    const { app } = monorepo({ 'node_modules/@saywright/vite/package.json': { name: '@saywright/vite', version: '0.1.0' } });
    expect(await main(['connect', app], ctx)).toBe(0);
    expect(out.join('\n')).not.toMatch(/Installed @saywright/);
    const probe = probeFolder(app);
    expect(target()).toEqual({ url: probe.url, root: app, framework: probe.framework, start: probe.start, studio: 'http://localhost:7357' });
    expect(probe).toMatchObject({ plugin: true, connection: 'plugin', packageManager: 'yarn' });
  });

  it('adds nothing to a SvelteKit app: the studio shows it through its proxy', async () => {
    const kit = tree({
      'package.json': { name: 'kit', scripts: { dev: 'vite dev' }, devDependencies: { '@sveltejs/kit': '^3', vite: '^8' } },
      'vite.config.ts': `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`,
      'src/app.html': '<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>',
    });
    expect(await main(['connect', kit], ctx)).toBe(0);
    expect(fs.readFileSync(path.join(kit, 'vite.config.ts'), 'utf8')).not.toContain('saywright');
    expect(out.join('\n')).toMatch(/Connected kit \(SvelteKit\)/);
    expect(out.join('\n')).toMatch(/Nothing to add to its code: the studio shows it through its proxy/);
    expect(target()).toMatchObject({ framework: 'sveltekit', url: 'http://localhost:5173', start: 'npm run dev' });
  });

  it('connects a folder of HTML at the address it gets once served: by its start script, or by the studio', async () => {
    const page = '<!doctype html><html><head><title>Brochure</title></head><body></body></html>';
    const scripted = tree({ 'package.json': { name: 'brochure', scripts: { start: 'serve .' } }, 'index.html': page });
    expect(await main(['connect', scripted], ctx)).toBe(0);
    expect(out.join('\n')).toMatch(/App: started with “npm start”, at the address it prints/);
    expect(out.join('\n')).not.toMatch(/null/);
    expect(target()).toMatchObject({ url: 'http://localhost:0', framework: 'static', start: 'npm start' });
    out = [];
    const plain = tree({ 'package.json': { name: 'plain' }, 'index.html': page });
    expect(await main(['connect', plain], ctx)).toBe(0);
    expect(out.join('\n')).toMatch(/App: served by the studio/);
    expect(target()).toMatchObject({ url: 'http://localhost:0', framework: 'static', start: null });
  });

  it('changes nothing when the plugin needs the app’s package manager and this computer hasn’t got it', async () => {
    installed();
    const { app } = monorepo();
    const config = fs.readFileSync(path.join(app, 'vite.config.mts'), 'utf8');
    expect(await main(['connect', app], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/web installs its packages with yarn, which isn’t installed on this computer/);
    expect(fs.readFileSync(path.join(app, 'vite.config.mts'), 'utf8')).toBe(config);
    expect(fs.existsSync(path.join(ctx.layout.dataDir, 'target.json'))).toBe(false);
  });

  it('runs the app with npm, saying why, when the package manager it uses isn’t installed', async () => {
    installed();
    const dir = tree({ 'package.json': { name: 'admin', scripts: { dev: 'vite' }, devDependencies: { vite: '^7', '@saywright/vite': '^0.1.0' } }, 'pnpm-lock.yaml': '', 'vite.config.ts': `export default { server: { port: 3333 }, plugins: [] };\n` });
    expect(await main(['connect', dir, '--dry-run'], ctx)).toBe(0);
    expect(out.join('\n')).toMatch(/App: http:\/\/localhost:3333\s+\(started with “npm run dev”\)/);
    expect(out.join('\n')).toMatch(/It uses pnpm, which isn’t installed on this computer, so it runs with npm/);
  });
});

describe('setup and doctor', () => {
  /** The default speech models, as setup leaves them: each of their files there. */
  const speechModels = () => tree(Object.fromEntries(MODELS.filter((m) => m.default).flatMap((m) => m.files.map((f) => [`${m.archive}/${f}`, 'x']))));
  const engine = new SpeechService(fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-speech-')), '', () => undefined).status().runtime !== 'missing';
  const saved = process.env.SAYWRIGHT_SPEECH_DIR;
  beforeEach(() => {
    // Nothing is downloaded, and no AI app is asked whether it is signed in.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    installed();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SAYWRIGHT_SPEECH_DIR;
    else process.env.SAYWRIGHT_SPEECH_DIR = saved;
  });

  it.skipIf(!engine)('doctor finds the speech models where SAYWRIGHT_SPEECH_DIR says', async () => {
    process.env.SAYWRIGHT_SPEECH_DIR = speechModels();
    await main(['doctor'], ctx);
    expect(out.join('\n')).toMatch(/✓ Speech models: Omnilingual/);
  });

  it.skipIf(!engine)('setup finds them there too, set in .env.local, and downloads none of them again', async () => {
    delete process.env.SAYWRIGHT_SPEECH_DIR;
    fs.writeFileSync(path.join(ctx.layout.envDir, '.env.local'), `SAYWRIGHT_SPEECH_DIR=${speechModels()}\n`);
    const install = vi.spyOn(SpeechService.prototype, 'install');
    // Installed from npm: no test browser to install.
    ctx = { ...ctx, layout: { ...ctx.layout, sample: { source: 'shipped', root: 'copied' } } };
    expect(await main(['setup', '--no-best-arabic'], ctx)).toBe(0);
    expect(out.join('\n')).toMatch(/✓ Speech model: Omnilingual/);
    expect(out.join('\n')).toMatch(/✓ Speech model: Parakeet/);
    expect(install).not.toHaveBeenCalled();
    expect(process.env.SAYWRIGHT_SPEECH_DIR).toBeUndefined();
  });
});

describe('the studio, once started', () => {
  /** What `saywright mcp` (started by Claude Desktop) answers to one message. */
  const mcpCommand = (home: string, message: unknown) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts/saywright.mjs'), 'mcp'], { env: { ...process.env, SAYWRIGHT_HOME: home } });
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d));
      child.on('close', () => resolve(text));
      child.stdin.end(`${JSON.stringify(message)}\n`);
    });

  it('says who answers (the test stand-in), and AI apps reach it through saywright mcp before its settings are opened', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-started-'));
    const ai = process.env.SAYWRIGHT_AI;
    process.env.SAYWRIGHT_AI = 'fake';
    const layout = { ...repoLayout(ROOT), dataDir: home, envDir: home };
    const studio = await createStudioApi(layout);
    const server = http.createServer(dispatch(studioRoutes(studio, layout)));
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      expect(await new Promise<string>((resolve) => announce(studio, layout, (server.address() as AddressInfo).port, resolve))).toMatch(/AI: test stand-in \(SAYWRIGHT_AI=fake\)/);
      const answer = await mcpCommand(home, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-desktop' } } });
      expect(JSON.parse(answer)).toMatchObject({ id: 1, result: { serverInfo: { name: 'saywright' } } });
    } finally {
      studio.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (ai === undefined) delete process.env.SAYWRIGHT_AI;
      else process.env.SAYWRIGHT_AI = ai;
    }
  }, 30_000);
});
