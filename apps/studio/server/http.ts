import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  raw: IncomingMessage;
}

export type Handler = (req: Req, res: ServerResponse) => unknown | Promise<unknown>;

const MAX_BODY = 4 * 1024 * 1024;
const MAX_BINARY = 24 * 1024 * 1024;

/** Audio, images and video arrive as raw bytes; everything else is JSON (sent as text/plain by beacons). */
function isBinary(type: string): boolean {
  return /^(application\/octet-stream|audio\/|image\/|video\/)/.test(type);
}

async function readBody(req: IncomingMessage, bytes: boolean): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return undefined;
  const binary = bytes || isBinary(String(req.headers['content-type'] ?? ''));
  const max = binary ? MAX_BINARY : MAX_BODY;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (binary) return Buffer.concat(chunks);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

/** This computer: localhost, its loopback addresses, and *.localhost (each app the studio shows through its proxy). */
const LOCAL_ORIGIN = /^https?:\/\/((?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Let apps on this machine reach routes marked `cors` (session recording from the app's own tab). */
function allowOrigin(req: IncomingMessage, res: ServerResponse, extra: string[]): boolean {
  const origin = String(req.headers.origin ?? '');
  if (!origin || !(LOCAL_ORIGIN.test(origin) || extra.includes(origin))) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  /** Reachable from other local origins (the app being tested). */
  cors: boolean;
  /**
   * The body is raw bytes whatever its declared type, so pages can send it as
   * text/plain: no CORS preflight per request, and it works from sendBeacon.
   */
  bytes: boolean;
}

interface RouteOptions {
  cors?: boolean;
  bytes?: boolean;
}

export class Router {
  private routes: Route[] = [];
  /** Origins besides localhost that may use `cors` routes. */
  extraOrigins: string[] = [];

  add(method: string, pattern: string, handler: Handler, opts: RouteOptions = {}): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, cors: !!opts.cors, bytes: !!opts.bytes });
    return this;
  }

  get(p: string, h: Handler, opts?: RouteOptions) {
    return this.add('GET', p, h, opts);
  }
  post(p: string, h: Handler, opts?: RouteOptions) {
    return this.add('POST', p, h, opts);
  }
  put(p: string, h: Handler, opts?: RouteOptions) {
    return this.add('PUT', p, h, opts);
  }
  delete(p: string, h: Handler, opts?: RouteOptions) {
    return this.add('DELETE', p, h, opts);
  }

  /**
   * The route for a request, with its parameters decoded (a malformed %-escape is the caller's mistake: 400). When
   * several fit, the one that names more of the path wins, whatever order they were added in: `/apps/launcher` is
   * never taken for `/apps/:id`.
   */
  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    let best: { route: Route; params: Record<string, string>; named: number } | null = null;
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let named = 0;
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeParam(parts[i]);
        else if (p === parts[i]) named++;
        else {
          ok = false;
          break;
        }
      }
      if (ok && (!best || named > best.named)) best = { route, params, named };
    }
    return best && { route: best.route, params: best.params };
  }

  /** Connect-style middleware. Calls `next` for paths it does not own. */
  middleware(prefix: string) {
    return async (raw: IncomingMessage, res: ServerResponse, next: () => void) => {
      let url: URL;
      try {
        url = new URL(raw.url ?? '/', 'http://localhost');
      } catch {
        return sendJson(res, 400, { error: 'That address isn’t valid.' });
      }
      if (!url.pathname.startsWith(prefix)) return next();
      try {
        const path = url.pathname.slice(prefix.length) || '/';
        if (raw.method === 'OPTIONS') {
          const preflight = this.routes.some((r) => r.cors && this.match(r.method, path)?.route === r);
          if (preflight && allowOrigin(raw, res, this.extraOrigins)) {
            res.statusCode = 204;
            return res.end();
          }
          return sendJson(res, 404, { error: 'Not found' });
        }
        const found = this.match(raw.method ?? 'GET', path);
        if (!found) return sendJson(res, 404, { error: `No route for ${raw.method} ${url.pathname}` });
        // Browsers name the page that sent a request; only this computer's pages may write (simple requests skip the preflight).
        const allowed = sameOrigin(raw) || (found.route.cors && allowOrigin(raw, res, this.extraOrigins));
        if (!allowed) return sendJson(res, 403, { error: 'Not allowed from another origin' });
        const body = await readBody(raw, found.route.bytes);
        const result = await found.route.handler({ method: raw.method ?? 'GET', path, query: url.searchParams, params: found.params, body, raw }, res);
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, code: err.code });
        console.error('[saywright api]', err);
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    };
  }
}

function decodeParam(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, 'That address has a broken %-escape.');
  }
}

/** A request from the studio's own page (same host and port), or not from a web page at all. */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = String(req.headers.origin ?? '');
  const host = String(req.headers.host ?? '');
  try {
    return !origin || new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * A client that has stopped reading (a paused tab, a stuck script) is let go once this much is waiting for it, so the
 * studio doesn't keep every event for it. It reconnects and catches up, as after any dropped connection.
 */
const MAX_BACKLOG = 1024 * 1024;

/** Server-sent events for progress updates. */
export class EventHub {
  private clients = new Map<ServerResponse, ((event: string, data: unknown) => boolean) | undefined>();

  /** Stream events to a client: all of them, or those `only` lets through. */
  attach(res: ServerResponse, only?: (event: string, data: unknown) => boolean): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.set(res, only);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  emit(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [c, only] of this.clients) {
      if (only && !only(event, data)) continue;
      if (c.writableLength > MAX_BACKLOG) {
        this.clients.delete(c);
        c.destroy();
      } else c.write(frame);
    }
  }
}

export function asString(v: unknown, name: string, max = 4000): string {
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  if (v.length > max) throw new HttpError(400, `${name} is too long`);
  return v;
}
