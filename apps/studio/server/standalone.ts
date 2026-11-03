/**
 * The studio as one program (`npx saywright`): the built interface and the studio's API on one port of this
 * computer, without Vite. In the repository, `npm run dev` serves the same API through Vite instead (studioApi).
 */
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { announce, createStudioApi, PAGE_HEADERS, studioRoutes, type Middleware } from './index.ts';
import type { StudioLayout } from './layout.ts';

interface ServeOptions extends StudioLayout {
  /** The built interface: what `vite build` wrote. */
  clientDir: string;
  /** The port to try first; the next free one is used when it is taken, unless `strictPort`. */
  port: number;
  strictPort?: boolean;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** This computer's own names. A request naming any other host reached the port through DNS rebinding: refused. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** The build writes compressed copies of the interface's text files next to them (file.br, file.gz: see build.mjs). */
const COMPRESSIBLE = /\.(html|m?js|css|json|svg|txt)$/i;

/** The compressed copies a browser accepts, best first. */
function encodings(header: string | string[] | undefined): Array<{ name: 'br' | 'gzip'; ext: string }> {
  const accepted = new Set(
    String(header ?? '')
      .split(',')
      .map((part) => part.trim().split(';'))
      .filter(([, q]) => !q || !/^\s*q=0(\.0*)?\s*$/.test(q))
      .map(([name]) => name.trim().toLowerCase()),
  );
  return [
    ...(accepted.has('br') ? [{ name: 'br' as const, ext: '.br' }] : []),
    ...(accepted.has('gzip') ? [{ name: 'gzip' as const, ext: '.gz' }] : []),
  ];
}

/** A file's size, or null when it isn't a file (missing, a folder, or a name the file system refuses). */
function fileSize(file: string): number | null {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat?.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** The built interface. Addresses without a file extension are the interface's own routes: they get its page. */
export function staticFiles(dir: string): Middleware {
  const root = path.resolve(dir);
  const page = path.join(root, 'index.html');
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    const file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.statusCode = 403;
      return res.end();
    }
    let target = file;
    let size = fileSize(file);
    if (size === null) {
      if (path.extname(pathname)) return next();
      target = page;
      size = fileSize(page);
      if (size === null) return next();
    }
    res.setHeader('Content-Type', TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Built files carry a hash in their names, so they never change; the page is checked every time.
    res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    // The studio shows your app in a frame; nothing else may show the studio in one.
    if (target === page) {
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      for (const [name, value] of Object.entries(PAGE_HEADERS)) res.setHeader(name, value);
    }
    let send = target;
    if (COMPRESSIBLE.test(target)) {
      res.setHeader('Vary', 'Accept-Encoding');
      for (const enc of encodings(req.headers['accept-encoding'])) {
        const packed = fileSize(target + enc.ext);
        if (packed === null) continue;
        res.setHeader('Content-Encoding', enc.name);
        send = target + enc.ext;
        size = packed;
        break;
      }
    }
    res.setHeader('Content-Length', size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(send)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}

/** Connect-style dispatch: each middleware is offered the requests under its route, in order. */
export function dispatch(stack: Array<[route: string, handler: Middleware]>) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? '/').split('?')[0];
    let i = 0;
    const fail = (err: unknown) => {
      console.error('[saywright]', err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    };
    const next = (): void => {
      while (i < stack.length) {
        const [route, handler] = stack[i++];
        if (route !== '/' && pathname !== route && !pathname.startsWith(`${route}/`)) continue;
        // A handler can throw before it returns a promise, or reject after: either way the request gets an answer.
        try {
          Promise.resolve(handler(req, res, next)).catch(fail);
        } catch (err) {
          fail(err);
        }
        return;
      }
      res.statusCode = 404;
      res.end('Not found');
    };
    next();
  };
}

/** Listen on this computer only; the next port when this one is taken. */
function listen(server: http.Server, first: number, strict: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && !strict && port < first + 20) attempt(port + 1);
        else reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use. Choose another with --port.`) : err);
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve(port);
      });
    };
    attempt(first);
  });
}

/** Start the studio. Resolves once it listens, with its address and a way to stop it. */
export async function serveStudio(opts: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const studio = await createStudioApi(opts);
  const handle = dispatch([...studioRoutes(studio, opts), ['/', staticFiles(opts.clientDir)]]);
  const server = http.createServer((req, res) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Saywright answers only on this computer’s own addresses (localhost).');
    }
    handle(req, res);
  });
  // Long-lived event streams and AI requests: no request timeout.
  server.requestTimeout = 0;
  const port = await listen(server, opts.port, !!opts.strictPort);
  const url = `http://localhost:${port}`;
  announce(studio, opts, port);
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        studio.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
