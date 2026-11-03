/**
 * The plugin's routes on the app's dev server: the studio's server may say where the studio runs (on this
 * computer only); a web page may not, whatever it claims.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import saywright from '../src/index';

type Handler = (req: unknown, res: unknown, next?: () => void) => void;

function routes(): Record<string, Handler> {
  const all: Record<string, Handler> = {};
  const plugin = saywright();
  const configure = plugin.configureServer as (server: unknown) => void;
  configure({ middlewares: { use: (route: string, fn: Handler) => (all[route] = fn) } });
  return all;
}

function call(fn: Handler, { method = 'GET', headers = {}, body = '' }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, headers, destroy: () => undefined });
    const res = {
      statusCode: 200,
      setHeader: () => undefined,
      end(text = '') {
        resolve({ status: this.statusCode, body: String(text) });
      },
    };
    fn(req, res);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  });
}

describe('where the studio runs', () => {
  it('is told by the studio’s server, on this computer only', async () => {
    const r = routes();
    expect((await call(r['/__saywright/studio'], { method: 'POST', body: JSON.stringify({ url: 'http://localhost:7400' }) })).status).toBe(200);
    expect(JSON.parse((await call(r['/__saywright/info'])).body).studio).toBe('http://localhost:7400');
    expect((await call(r['/__saywright/studio'], { method: 'POST', body: JSON.stringify({ url: 'https://evil.example' }) })).status).toBe(400);
  });

  it('can’t be changed by a web page', async () => {
    const r = routes();
    const res = await call(r['/__saywright/studio'], { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: JSON.stringify({ url: 'http://localhost:6666' }) });
    expect(res.status).toBe(403);
    expect(JSON.parse((await call(r['/__saywright/info'])).body).studio).toBeNull();
  });
});
