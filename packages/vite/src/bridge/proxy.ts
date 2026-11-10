/**
 * When the studio shows a site through its proxy, the site's own absolute
 * addresses (https://example.com/...) would leave the proxy: requests,
 * sockets, workers, links, forms and navigations are pointed back into it
 * before the site's scripts run. A site on this computer that calls another
 * port of it (its API at http://localhost:5010) has those requests go through
 * the proxy too: from the proxy's address they would meet the API's CORS
 * rules as a stranger. The proxy applies those rules as the browser would
 * (each request says whether it carries the page's credentials). A request whose
 * answer the page can't read anyway (a no-cors fetch, a simple beacon) isn't
 * rerouted: the browser sends it itself and keeps its answer opaque, as
 * outside the studio, and the proxy never answers one. Cookies are kept under the site's own prefix in the
 * browser (cookies ignore ports, and other apps share localhost): the site's
 * scripts see their own names. Service workers are kept off, so an old cached
 * page never hides the studio.
 */
import { PROXY_CREDENTIALS_HEADER } from '../protocol';

interface ProxyConfig {
  /** The real site, e.g. https://example.com */
  upstream: string;
  /** Where the studio shows it, e.g. http://localhost:5281 */
  proxy: string;
  /** This site's cookie prefix in the browser, e.g. ds5281~ */
  cookies?: string;
  /** The studio's own address: the bridge's requests to it go straight there. */
  studio?: string;
}

/** This computer's own names. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const portOf = (u: URL) => u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80');

/**
 * Where an address the page uses goes when the site is shown through the proxy. The site's own address (any scheme,
 * protocol-relative too) → the same path in the proxy. With `requests` (fetch, XHR, sockets, event streams), when the
 * site is on this computer: another port of it → the proxy's path for that port, /__saywright/<http|https>/<host:port>/…,
 * so the request leaves from the site's own address, as it does outside the studio. Anything else stays as it is.
 */
export function viaProxy(input: string, base: string, c: Pick<ProxyConfig, 'upstream' | 'proxy' | 'studio'>, requests: boolean, credentials = false): string {
  try {
    const u = new URL(input, base);
    const up = new URL(c.upstream);
    const proxy = new URL(c.proxy);
    if (u.hostname === up.hostname && portOf(u) === portOf(up)) {
      u.protocol = u.protocol.startsWith('ws') ? 'ws:' : proxy.protocol;
      u.host = proxy.host;
      return u.href;
    }
    if (!requests || !/^(https?|wss?):$/.test(u.protocol) || !LOOPBACK.test(up.hostname) || !LOOPBACK.test(u.hostname)) return input;
    // Already the proxy, or the studio itself: as it is.
    if (portOf(u) === portOf(proxy)) return input;
    if (c.studio && portOf(u) === portOf(new URL(c.studio))) return input;
    // `+cred`: sent with the page's credentials, so the proxy sends the site's cookies with it (as the browser does).
    const scheme = (u.protocol === 'https:' || u.protocol === 'wss:' ? 'https' : 'http') + (credentials ? '+cred' : '');
    const via = `${u.protocol.startsWith('ws') ? 'ws:' : proxy.protocol}//${proxy.host}/__saywright/${scheme}/${u.hostname}:${portOf(u)}`;
    return via + u.pathname + u.search + u.hash;
  } catch {
    return input;
  }
}

declare global {
  interface Window {
    __SAYWRIGHT_PROXY__?: ProxyConfig;
  }
}

export function proxyConfig(): ProxyConfig | null {
  const c = window.__SAYWRIGHT_PROXY__;
  return c && typeof c.upstream === 'string' && typeof c.proxy === 'string' ? c : null;
}

export function installProxyRewrites(c: ProxyConfig): void {
  /** Navigations, workers, history: the site's own address only. */
  const to = (input: string): string => viaProxy(input, location.href, c, false);
  /** Requests: its API on another port of this computer too, saying whether they carry the page's credentials. */
  const toRequest = (input: string, credentials = false): string => viaProxy(input, location.href, c, true, credentials);
  const mapped =
    (fn: (s: string) => string) =>
    <T>(url: T): T =>
      typeof url === 'string' ? (fn(url) as T) : url instanceof URL ? (new URL(fn(url.href)) as T) : url;
  const toAny = mapped(to);
  const requestAny = mapped((u) => toRequest(u));
  /** Sockets and beacons always carry the site's cookies. */
  const requestWithCredentials = mapped((u) => toRequest(u, true));

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    // Cookies go to another origin only with credentials: 'include', as outside the studio.
    const credentials = (init?.credentials ?? (input instanceof Request ? input.credentials : 'same-origin')) === 'include';
    // A no-cors request to another port is the browser's to send: its answer stays opaque to the page.
    const opaque = (init?.mode ?? (input instanceof Request ? input.mode : 'cors')) === 'no-cors';
    const route = (u: string) => (opaque ? to(u) : toRequest(u, credentials));
    if (input instanceof Request) {
      const next = route(input.url);
      return nativeFetch(next === input.url ? input : new Request(next, input), init);
    }
    const url = typeof input === 'string' ? route(input) : new URL(route(input.href));
    return nativeFetch(url, init);
  };

  // An XMLHttpRequest says it carries the page's credentials as it is sent: withCredentials is set after open.
  const proxied = new WeakSet<XMLHttpRequest>();
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const next = requestAny(url);
    if (String(next).includes('/__saywright/')) proxied.add(this);
    else proxied.delete(this);
    return (open as (...a: unknown[]) => void).call(this, method, next, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (proxied.has(this) && this.withCredentials) this.setRequestHeader(PROXY_CREDENTIALS_HEADER, 'include');
    return send.call(this, body);
  };

  const wrap = <C extends new (...args: never[]) => object>(Native: C, map: <T>(url: T) => T): C =>
    new Proxy(Native, {
      construct(target, args: unknown[]) {
        if (args.length) args[0] = map(args[0]);
        return Reflect.construct(target, args);
      },
    });
  const w = window as unknown as Record<string, (new (...a: never[]) => object) | undefined>;
  for (const [name, map] of [['WebSocket', requestWithCredentials], ['Worker', toAny], ['SharedWorker', toAny]] as const) {
    const Native = w[name];
    if (Native) w[name] = wrap(Native, map);
  }
  // An event stream carries the page's credentials when it was opened withCredentials.
  if (w.EventSource) {
    w.EventSource = new Proxy(w.EventSource, {
      construct(target, args: unknown[]) {
        if (args.length) args[0] = (args[1] as EventSourceInit | undefined)?.withCredentials ? requestWithCredentials(args[0]) : requestAny(args[0]);
        return Reflect.construct(target, args);
      },
    });
  }
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    // A beacon is a cors request only with a body of another type than a form's or text (JSON in a Blob): the others
    // are no-cors, sent by the browser itself.
    const cors = (data?: BodyInit | null) => data instanceof Blob && !!data.type && !/^(?:text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(data.type);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => beacon(cors(data) ? requestWithCredentials(url) : toAny(url), data);
  }

  for (const name of ['pushState', 'replaceState'] as const) {
    const native = History.prototype[name];
    History.prototype[name] = function (this: History, state: unknown, unused: string, url?: string | URL | null) {
      return native.call(this, state, unused, url == null ? url : toAny(url));
    };
  }
  const nativeOpen = window.open;
  window.open = function (this: Window, url?: string | URL, ...rest: unknown[]) {
    return (nativeOpen as (...a: unknown[]) => Window | null).call(this, url === undefined ? url : toAny(url), ...rest);
  } as typeof window.open;

  // Forms written with the site's full address post into the proxy, keeping their method and fields: their action
  // (and the button's formaction) is rewritten as they are sent, whoever built them (the page's scripts too).
  const retarget = (el: HTMLFormElement | HTMLButtonElement | HTMLInputElement | null | undefined, attr: 'action' | 'formAction') => {
    const target = el as unknown as Record<string, string> | null | undefined;
    const name = attr === 'action' ? 'action' : 'formaction';
    if (!el || !el.hasAttribute(name) || !target) return;
    const next = to(target[attr]);
    if (next !== target[attr]) target[attr] = next;
  };
  document.addEventListener(
    'submit',
    (e) => {
      retarget(e.target as HTMLFormElement | null, 'action');
      retarget((e as SubmitEvent).submitter as HTMLButtonElement | null, 'formAction');
    },
    true,
  );
  // form.submit() sends without a submit event.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    retarget(this, 'action');
    return nativeSubmit.call(this);
  };

  // Navigations to the site's address (links, location.href = …) stay in the proxy. A form's submission is left alone:
  // cancelling it and going there again would lose its method and fields (its action was rewritten above).
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigate', (event) => {
    const e = event as Event & { destination: { url: string }; cancelable: boolean; hashChange: boolean; downloadRequest: string | null; formData: FormData | null };
    if (e.formData) return;
    const next = to(e.destination.url);
    if (next !== e.destination.url && e.cancelable && !e.hashChange && !e.downloadRequest) {
      e.preventDefault();
      location.assign(next);
    }
  });
  // Browsers without the Navigation API: links written with the site's full address.
  if (!navigation) {
    document.addEventListener(
      'click',
      (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || a.hasAttribute('download') || to(a.href) === a.href) return;
        e.preventDefault();
        if (a.target === '_blank') window.open(to(a.href), '_blank');
        else location.href = to(a.href);
      },
      true,
    );
  }

  if (c.cookies) installCookieNamespace(c.cookies);

  const sw = navigator.serviceWorker;
  if (sw) {
    void sw.getRegistrations?.().then((regs) => regs.forEach((r) => void r.unregister()));
    try {
      Object.defineProperty(sw, 'register', { configurable: true, value: () => Promise.reject(new DOMException('Service workers are off while the studio shows this site.', 'SecurityError')) });
    } catch {
      /* read-only in this browser */
    }
  }
}

/** document.cookie and cookieStore, seen through this site's prefix: its own cookies, under their own names. */
function installCookieNamespace(prefix: string): void {
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (desc?.get && desc.set) {
    const get = desc.get;
    const set = desc.set;
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: Document) {
        return (get.call(this) as string)
          .split(/;\s*/)
          .filter((kv) => kv.startsWith(prefix))
          .map((kv) => kv.slice(prefix.length))
          .join('; ');
      },
      set(this: Document, value: string) {
        const cleaned = String(value)
          .replace(/;\s*(domain\s*=[^;]*|secure|partitioned)\s*(?=;|$)/gi, '')
          .trimStart();
        set.call(this, prefix + cleaned);
      },
    });
  }
  type Cookie = { name: string; [k: string]: unknown };
  interface Store {
    get: (arg?: unknown) => Promise<Cookie | null>;
    getAll: (arg?: unknown) => Promise<Cookie[]>;
    set: (a: unknown, b?: unknown) => Promise<void>;
    delete: (arg: unknown) => Promise<void>;
  }
  const store = (window as unknown as { cookieStore?: Store }).cookieStore;
  if (!store) return;
  const own = (c: Cookie | null | undefined) => !!c && c.name.startsWith(prefix);
  const strip = (c: Cookie) => ({ ...c, name: c.name.slice(prefix.length) });
  const named = (arg: unknown) => (typeof arg === 'string' ? prefix + arg : arg && typeof arg === 'object' && 'name' in arg ? { ...(arg as object), name: prefix + String((arg as Cookie).name) } : arg);
  const getAll = store.getAll.bind(store);
  const setNative = store.set.bind(store);
  const del = store.delete.bind(store);
  store.getAll = async (arg?: unknown) => (await getAll(arg === undefined ? undefined : named(arg))).filter(own).map(strip);
  store.get = async (arg?: unknown) => (await store.getAll(arg))[0] ?? null;
  store.set = (a: unknown, b?: unknown) => {
    if (typeof a === 'string') return setNative(prefix + a, b);
    const { domain: _d, partitioned: _p, ...rest } = a as Cookie & { domain?: unknown; partitioned?: unknown };
    return setNative({ ...rest, name: prefix + rest.name });
  };
  store.delete = (arg: unknown) => del(named(arg));
}
