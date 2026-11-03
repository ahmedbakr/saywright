/**
 * @saywright/vite — add to a Vite + React app to make it pointable from
 * Saywright. Dev server only; production builds are untouched.
 *
 *   import saywright from '@saywright/vite';
 *   export default defineConfig({ plugins: [saywright(), react()] });
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { annotate } from './annotate';
import { UpdateHold } from './batch';
import { PROTOCOL_VERSION } from './protocol';
import { isInside, workspaceRoot } from './workspace';

export interface SaywrightOptions {
  /** Files to annotate, among the app's and those of the workspace (monorepo) it is part of. Default: .jsx and .tsx files. */
  include?: RegExp;
  /** Files to skip. node_modules is never annotated. */
  exclude?: RegExp;
  /** Extra studio origins allowed to talk to the bridge (the studio that announced itself, or the default address, always is). */
  studioOrigins?: string[];
  /** Where the studio runs. Default: what the studio announces when it starts, else http://localhost:7357. */
  studio?: string;
  /** Show the test-session recorder when the app is open in its own tab. Default: true. */
  widget?: boolean;
}

let cached: { file: string; mtime: number; code: string } | null = null;

/** The bridge script, read again when it has been rebuilt (updating Saywright doesn't need an app restart). */
function readBridge(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of [path.join(here, 'bridge.js'), path.join(here, '../dist/bridge.js')]) {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (cached?.file !== file || cached.mtime !== mtime) cached = { file, mtime, code: fs.readFileSync(file, 'utf8') };
    return cached.code;
  }
  return 'console.warn("[saywright] bridge.js missing: run `npm run build:plugin`.")';
}

export default function saywright(options: SaywrightOptions = {}): Plugin {
  const include = options.include ?? /\.[jt]sx$/;
  const exclude = options.exclude ?? /[\\/]node_modules[\\/]/;
  let root = process.cwd();
  // Paths stay relative to the app's root: a sibling package's file is "../packages/ui/Button.tsx".
  let scope = root;
  // The studio announces itself here when it starts, so the app knows where to send sessions.
  let studio: string | null = options.studio ?? process.env.SAYWRIGHT_STUDIO_URL ?? null;

  return {
    name: 'saywright',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
      scope = workspaceRoot(root) ?? root;
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (!include.test(file) || exclude.test(file) || /[\\/]node_modules[\\/]/.test(file) || file.startsWith('\0')) return null;
      const rel = path.relative(root, file).split(path.sep).join('/');
      // Beyond the workspace the studio couldn't open the file.
      if (!rel || path.isAbsolute(rel) || !isInside(scope, file)) return null;
      const out = annotate(code, file, rel);
      return out ? { code: out.code, map: out.map } : null;
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          children: `window.__SAYWRIGHT__=${JSON.stringify({ origins: options.studioOrigins ?? [], studio, widget: options.widget ?? true })}`,
          injectTo: 'head-prepend',
        },
        // First in the page, so a test session also catches errors and requests from the app's first moments.
        { tag: 'script', attrs: { type: 'module', src: '/__saywright/bridge.js' }, injectTo: 'head-prepend' },
      ];
    },
    configureServer(server) {
      server.middlewares.use('/__saywright/bridge.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readBridge());
      });
      // Lets the studio discover where this app's source lives from its URL alone.
      server.middlewares.use('/__saywright/info', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ root, version: PROTOCOL_VERSION, studio }));
      });
      // The studio's server says where the studio runs. Web pages always name their origin when they post: refused,
      // so no site can point the app's recordings somewhere else.
      server.middlewares.use('/__saywright/studio', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        if (req.headers.origin) {
          res.statusCode = 403;
          return res.end();
        }
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()).length > 2000 && req.destroy());
        req.on('end', () => {
          try {
            const url = new URL(JSON.parse(body).url as string);
            if (!/^https?:$/.test(url.protocol) || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) throw new Error('local only');
            if (!options.studio) studio = url.origin;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end();
          }
        });
      });
      // The studio's server is about to write a change of several files: the page's updates wait for all of them and
      // go as one (see batch.ts). Refused to web pages, like the route above.
      let hold: UpdateHold | null = null;
      server.middlewares.use('/__saywright/hold', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        if (req.headers.origin) {
          res.statusCode = 403;
          return res.end();
        }
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()).length > 200_000 && req.destroy());
        req.on('end', () => {
          try {
            const files = (JSON.parse(body) as { files?: unknown }).files;
            if (!Array.isArray(files) || !files.length || files.length > 500 || !files.every((f) => typeof f === 'string' && path.isAbsolute(f))) throw new Error('files');
            // Only this app's files: another app's change is no reason to hold this one's page.
            const ours = files.filter((f) => isInside(scope, f));
            if (ours.length) {
              hold ??= new UpdateHold(server);
              hold.hold(ours);
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, held: ours.length > 0 }));
          } catch {
            res.statusCode = 400;
            res.end();
          }
        });
      });
    },
  };
}

export { saywright };
