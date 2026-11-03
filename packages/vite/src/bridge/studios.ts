/**
 * Which page may drive the bridge: the studio, and nothing else. Any page on
 * this computer can put the app in a frame and talk to it, and a page that
 * drives the bridge can read the app, act in it and record what is typed.
 * So the bridge answers the studio the plugin or the studio's own script
 * names (the default address when neither does), the origins the app allows
 * (studioOrigins), and another page on this computer only once it is known to
 * be a studio: the app's dev server names it, or its own API answers from there.
 */
import { STUDIO_URL } from '../protocol';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** One server: the same origin, or the same port under this computer's loopback names (localhost is 127.0.0.1). */
export function sameServer(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin || (x.protocol === y.protocol && x.port === y.port && LOOPBACK.has(x.hostname) && LOOPBACK.has(y.hostname));
  } catch {
    return false;
  }
}

function loopback(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** How long an unknown page waits before it is asked about again (it says hello several times a second). */
const ASK_AGAIN_MS = 3000;

export class StudioOrigins {
  private known: string[];
  private proven = new Set<string>();
  private asking = new Set<string>();

  constructor(
    config: { studio?: string | null; origins?: string[] } | undefined,
    private readonly get: (url: string) => Promise<unknown> = getJson,
  ) {
    this.known = [config?.studio || STUDIO_URL, ...(config?.origins ?? [])].filter((o): o is string => typeof o === 'string' && !!o);
  }

  trusted(origin: string): boolean {
    return this.proven.has(origin) || this.known.some((k) => sameServer(k, origin));
  }

  /** Find out whether a page on this computer the bridge doesn't know is a studio; its next hello gets the answer. */
  async check(origin: string): Promise<void> {
    if (this.trusted(origin) || this.asking.has(origin) || !loopback(origin)) return;
    this.asking.add(origin);
    try {
      // The studio tells the app's dev server where it is when it opens the app.
      const info = (await this.get('/__saywright/info').catch(() => null)) as { studio?: unknown } | null;
      if (typeof info?.studio === 'string' && !this.known.includes(info.studio)) this.known.push(info.studio);
      if (this.trusted(origin)) return;
      // A dev server restarted since has forgotten: a studio answers from its own address.
      const said = (await this.get(`${origin}/api/sessions/active`).catch(() => null)) as { endpoint?: unknown } | null;
      if (typeof said?.endpoint === 'string' && sameServer(said.endpoint, origin)) this.proven.add(origin);
    } finally {
      setTimeout(() => this.asking.delete(origin), ASK_AGAIN_MS);
    }
  }
}
