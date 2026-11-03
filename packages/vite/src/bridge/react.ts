/**
 * Best-effort React development info for apps without the Vite plugin's
 * source attributes (Next.js, Create React App, webpack): the component path
 * of an element and where its JSX was written.
 */
import type { SourceFrame } from '../protocol';

export interface Fiber {
  type: unknown;
  return: Fiber | null;
  child?: Fiber | null;
  stateNode?: unknown;
  memoizedProps?: unknown;
  _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number } | null;
  _debugStack?: { stack?: string } | null;
  _debugOwner?: Fiber | ServerOwner | null;
}

/** A server component, as React's development build describes it in the browser (it has no fiber). */
interface ServerOwner {
  name?: string;
  owner?: Fiber | ServerOwner | null;
  debugStack?: { stack?: string } | null;
  stack?: string;
  props?: unknown;
}

let fiberKey: string | null = null;

/** Whether React rendered this element (dev builds attach the fiber to it). */
export function hasFiber(el: Element): boolean {
  return !!fiberOf(el);
}

export function fiberOf(el: Element): Fiber | null {
  // React names the property once per page ("__reactFiber$x1y2"): found on the first element React rendered.
  // An element React didn't render (the body, the recorder's button) has none, which says nothing about the next one.
  if (!fiberKey || !(fiberKey in el)) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return null;
    fiberKey = key;
  }
  return (el as unknown as Record<string, Fiber | undefined>)[fiberKey] ?? null;
}

function nameOf(type: unknown): string | null {
  if (!type) return null;
  if (typeof type === 'function') {
    const f = type as { displayName?: string; name?: string };
    return f.displayName || f.name || null;
  }
  if (typeof type === 'object') {
    const o = type as { displayName?: string; render?: unknown; type?: unknown };
    return o.displayName || nameOf(o.render) || nameOf(o.type);
  }
  return null;
}

/** Framework plumbing that says nothing about the app. */
const PLUMBING = /^(Anonymous|Fragment|Suspense|StrictMode|Provider|Consumer|Context|ErrorBoundary|InnerLayoutRouter|OuterLayoutRouter|LayoutRouter|RenderFromTemplateContext|ScrollAndFocusHandler|RedirectBoundary|NotFoundBoundary|LoadingBoundary|HotReload|Router|AppRouter|ServerRoot|Root|ReactDevOverlay|SegmentViewNode|SegmentStateProvider|DevRootHTTPAccessFallbackBoundary|HTTPAccessFallbackBoundary|AppDevOverlayErrorBoundary|ClientPageRoot|ClientSegmentRoot|Head|Html|Body)$|^_|Boundary$|Handler$|Context$|Provider$|Router$|^Next[A-Z]/;

/** "Checkout › CouponField › Button" for the element, outermost first (up to six named components). */
export function componentPath(el: Element | Fiber | null): string | undefined {
  let f = el instanceof Element ? fiberOf(el) : el;
  const names: string[] = [];
  for (let i = 0; f && i < 200 && names.length < 6; i++, f = f.return) {
    const n = nameOf(f.type);
    if (n && n.length > 1 && !PLUMBING.test(n) && names[names.length - 1] !== n) names.push(n);
  }
  return names.length ? names.reverse().join(' › ') : undefined;
}

/**
 * Where a stack frame points, kept as reported: the module or bundle URL, or
 * the file path, which the studio server follows through source maps to the
 * original file. (Even Vite's /src/App.tsx is transformed code: its line
 * numbers are not the source's.) `raw` keeps webpack's eval'd modules as they
 * are named ("webpack-internal:///./src/App.js"): their lines are the
 * transformed code's too.
 */
function frameLocation(url: string, raw = false): string | null {
  const wp = /webpack-internal:\/\/\/(?:\([^)]*\)\/)?\.\/(.+)$/.exec(url);
  if (wp) return /(^|\/)node_modules\//.test(wp[1]) ? null : raw ? url : wp[1];
  if (url.startsWith('file://')) return decodeURIComponent(url.slice(7));
  // A path: on a server, or when this runs in Node (tests), where Windows writes it with its drive (D:\app\x.tsx).
  if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) return url;
  try {
    const p = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
    if (/^(@vite|@id|@react-refresh)\b/.test(p) || /(^|\/)node_modules\//.test(p)) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * A stack line's place: "at fn (where:12:5)" or "at where:12:5". Read from the end, because webpack names its
 * modules with parentheses ("webpack-internal:///(app-pages-browser)/./src/app/(main)/page.tsx").
 */
function frameOf(line: string): { url: string; line: string; col: string } | null {
  const s = line.trim();
  const pos = /:(\d+):(\d+)\)?$/.exec(s);
  if (!pos) return null;
  // Firefox and Safari: "fn@where:12:5".
  const other = /^[^@\s]*@((?:https?|webpack-internal|file):\/\/.+):(\d+):(\d+)$/.exec(s);
  if (other) return { url: other[1], line: other[2], col: other[3] };
  if (!s.startsWith('at ')) return null;
  let start = 3;
  if (s.endsWith(')')) {
    start = -1;
    for (let i = pos.index - 1, depth = 0; i >= 3; i--) {
      if (s[i] === ')') depth++;
      else if (s[i] === '(' && depth-- === 0) {
        start = i + 1;
        break;
      }
    }
    if (start < 0) return null;
  }
  // React names a server component's frames "rsc://React/Server/…" (or "about://React/Server/…").
  const url = s.slice(start, pos.index).replace(/^(?:rsc|about):\/\/React\/Server\//, '');
  return /^(https?|webpack-internal|file):\/\/|^\/|^[A-Za-z]:[\\/]/.test(url) ? { url, line: pos[1], col: pos[2] } : null;
}

/** React's and libraries' own frames, which say nothing about where the app's JSX is. */
function isLibraryFrame(line: string): boolean {
  // Vite serves dependencies it bundled ahead as …/deps/name.js?v=hash, wherever its cache is.
  if (/react-dom|react\.development|jsx-dev-runtime|react-jsx|react-server-dom|node_modules|\/deps\/[^/?\s]+\.js\?v=|\/turbopack-[\w-]+\._\.js/.test(line)) return true;
  // React's own element-creation frames, which a bundle carries without a library path ("at exports.jsxs (main.js:…)").
  return /\bat (?:\S+\.)?(?:jsxs?|jsxDEV|jsxWithValidation\w*|createElement|cloneElement|react[_-]stack[_-]\w+)\b/.test(line);
}

/** The first place in a creation stack that is the app's code, and the function it is in (the component that wrote the JSX). */
function stackFrame(stack: string | undefined, raw = false): { at: string; fn: string | null } | null {
  if (!stack) return null;
  for (const line of stack.split('\n').slice(1)) {
    if (isLibraryFrame(line)) continue;
    const f = frameOf(line);
    const p = f && frameLocation(f.url, raw);
    if (p) return { at: `${p}:${f!.line}:${f!.col}`, fn: /^\s*at\s+(?:new\s+)?([\w$.]+)\s+\(/.exec(line)?.[1].split('.').pop() ?? null };
  }
  return null;
}

/** The stack React gives every element once it has made too many at once (about 10,000): it says nothing. */
const placeholder = (stack: string | undefined) => !!stack && /\bat UnknownOwner \(/.test(stack);

/** Where a fiber's JSX was written: React ≤18 records it, React ≥19.1 keeps the stack that created it. */
function fiberFrame(f: Fiber, raw = false): { at: string; fn: string | null } | null {
  const s = f._debugSource;
  if (s?.fileName) return { at: `${s.fileName}:${s.lineNumber}:${s.columnNumber ?? 1}`, fn: null };
  const stack = f._debugStack?.stack;
  return placeholder(stack) ? null : stackFrame(stack, raw);
}

const fiberSite = (f: Fiber, raw = false) => fiberFrame(f, raw)?.at ?? null;

/**
 * Where the element's JSX was written, from React's dev info: "src/App.tsx:12:5", a bundle location to map, or
 * null. Takes the element, or its fiber kept from earlier (React drops the link when it removes the element).
 */
export function reactSource(el: Element | Fiber | null): string | null {
  for (let f = el instanceof Element ? fiberOf(el) : el, i = 0; f && i < 3; i++, f = f.return) {
    const site = fiberSite(f);
    if (site) return site;
  }
  return null;
}

/** Where React recorded this element's own JSX, when that is the app's code (not a library's). */
export function ownSite(el: Element): string | null {
  const f = fiberOf(el);
  return f ? fiberSite(f) : null;
}

const isFiber = (o: Fiber | ServerOwner): o is Fiber => 'return' in o && 'type' in o;

/** Whether component `owner` renders `el` as its outermost element. */
function outermost(owner: Fiber, el: Element): boolean {
  let c = owner.child ?? null;
  for (let i = 0; c && typeof c.type !== 'string' && i < 60; i++) c = c.child ?? null;
  return !!c && c.stateNode === el;
}

/**
 * Whether the element gets what component `owner` was given: `<Button type="submit">` → `<button type="submit">`,
 * its class added to the element's, a handler passed on under another name (`onSelect` → `onClick`), or the text
 * it was given shown inside (`<MenuItem>Preferences</MenuItem>`).
 */
function passesProps(owner: Fiber | ServerOwner, host: Fiber): boolean {
  const given = ((isFiber(owner) ? owner.memoizedProps : owner.props) ?? {}) as Record<string, unknown>;
  const got = (host.memoizedProps ?? {}) as Record<string, unknown>;
  const passed = new Set<unknown>(Object.values(got).filter((v) => typeof v === 'function'));
  for (const [k, v] of Object.entries(given)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    if (k === 'className' && typeof v === 'string' && typeof got.className === 'string' && got.className.includes(v)) return true;
    if ((k in got && got[k] === v) || passed.has(v)) return true;
    if (k === 'children' && typeof v === 'string' && v.trim().length >= 2 && shows(host, v.trim())) return true;
  }
  return false;
}

/** Whether the element shows this text. */
function shows(host: Fiber, text: string): boolean {
  const node = host.stateNode as { textContent?: string | null } | null | undefined;
  return !!node?.textContent?.includes(text);
}

/**
 * Where React says an element came from, most precise first: its own JSX, then where each of the app's components
 * around it was used (libraries' components add none). `root` marks the components the element is the outermost
 * element of and gets its props from, through any library's layers: where those were used is where the element is
 * set up, as the Vite plugin's attributes say when a component spreads its props. The studio's server maps them.
 */
export function reactFrames(el: Element): SourceFrame[] {
  const host = fiberOf(el);
  // Production builds keep no owners.
  if (!host || !('_debugOwner' in host)) return [];
  const tag = el.tagName.toLowerCase();
  // React ≤18 records where JSX was written, React ≥19.1 the stack that created it (until it has made too many
  // elements at once); React 19.0 neither: then the components' own positions stand in.
  const recorded = '_debugSource' in host || ('_debugStack' in host && !placeholder(host._debugStack?.stack));
  const frames: SourceFrame[] = [];
  const own = recorded ? fiberFrame(host, true) : null;
  if (own) frames.push({ at: own.at, name: tag });
  // A menu or dialog library can put a dozen layers between the element and the app's code.
  const owners: (Fiber | ServerOwner)[] = [];
  for (let o = host._debugOwner ?? null; o && owners.length < 40; o = isFiber(o) ? (o._debugOwner ?? null) : (o.owner ?? null)) owners.push(o);
  const nameOfOwner = (o: Fiber | ServerOwner) => (isFiber(o) ? nameOf(o.type) : (o.name ?? null));
  let forwarded = true;
  let inner: Fiber | null = null;
  // The component that wrote the JSX last placed. An element handed to another component that clones it (Radix's
  // asChild) has that one for owner: the layers up to the one that wrote it are wrappers it passed through.
  let writer = own?.fn ?? null;
  for (let i = 0; i < owners.length && frames.length < 8; i++) {
    const o = owners[i];
    const name = nameOfOwner(o);
    if (recorded) {
      if (writer && name !== writer) {
        const at = owners.findIndex((x, j) => j > i && j < i + 12 && nameOfOwner(x) === writer);
        if (at > i) {
          i = at - 1;
          continue;
        }
      }
      const frame = isFiber(o) ? fiberFrame(o, true) : stackFrame(o.debugStack?.stack ?? o.stack, true);
      writer = frame?.fn ?? null;
      // A library's layer (made in a library) passes the element along; the app's components must pass their props.
      // A server component has no fiber to look into: what it was given must reach the element.
      forwarded = forwarded && (isFiber(o) ? outermost(o, el) && (!frame || passesProps(o, host)) : !!o.props && passesProps(o, host));
      // Beyond the element's own component and the one around it, only where the element is set up says anything.
      if (frame && (forwarded || i <= 1)) frames.push({ at: frame.at, ...(name ? { name } : {}), ...(forwarded ? { root: true } : {}) });
    } else if (isFiber(o)) {
      // React 19.0: where the owner's function is (the app's only), and what it wrote there.
      const wrote = inner ? nameOf(inner.type) : tag;
      const at = wrote ? whereDefined(o.type) : null;
      if (at && wrote && ((inner && forwarded) || i <= 1)) frames.push({ at, name: wrote, inside: true, ...(inner && forwarded ? { root: true } : {}) });
      forwarded = forwarded && outermost(o, el) && (!at || passesProps(o, host));
    } else break;
    inner = isFiber(o) ? o : null;
  }
  return frames;
}

/**
 * On a page the Vite plugin annotated: where the components that pass `el` their props were used (each instance
 * gets the plugin's attribute as a prop), inner first. The element's own attribute (`own`) may already come from an
 * instance further out, when components spread their props onto it: only those around that one count.
 */
export function instanceFrames(el: Element, attr: string, own: string): SourceFrame[] {
  const host = fiberOf(el);
  if (!host) return [];
  const around: Fiber[] = [];
  for (let f = host.return, i = 0; f && i < 60 && typeof f.type !== 'string' && outermost(f, el); f = f.return, i++) around.push(f);
  const attrOf = (f: Fiber) => (f.memoizedProps as Record<string, unknown> | null)?.[attr];
  const from = around.reduce((at, f, i) => (attrOf(f) === own ? i + 1 : at), 0);
  const frames: SourceFrame[] = [];
  for (const f of around.slice(from)) {
    const at = attrOf(f);
    if (typeof at !== 'string') continue;
    if (!passesProps(f, host)) break;
    const name = nameOf(f.type);
    frames.push({ at, ...(name ? { name } : {}), root: true });
  }
  return frames;
}

const defined = new WeakMap<object, string | null>();

/** The function React calls to render a component of this type (forwardRef's render, memo's inner component). */
function renderFunction(type: unknown): ((...args: unknown[]) => unknown) | null {
  let t = type;
  for (let i = 0; t && i < 4; i++) {
    if (typeof t === 'function') return t as (...args: unknown[]) => unknown;
    if (typeof t !== 'object') return null;
    const o = t as { render?: unknown; type?: unknown };
    t = o.render ?? o.type;
  }
  return null;
}

let bridgeUrl: string | null | undefined;

/** This script's address, to tell its own frames from the app's in a stack. */
function ownUrl(): string | null {
  if (bridgeUrl === undefined) {
    const line = new Error().stack?.split('\n').find((l) => frameOf(l));
    bridgeUrl = (line && frameOf(line)?.url) || null;
  }
  return bridgeUrl;
}

/** Fails as soon as a class component sets its props. */
function Throwing() {}
Object.defineProperty(Throwing.prototype, 'props', {
  set() {
    throw new Error('saywright');
  },
});

const isClass = (fn: (...args: unknown[]) => unknown) =>
  !!(fn.prototype as { isReactComponent?: unknown } | undefined)?.isReactComponent || /^class\b/.test(Function.prototype.toString.call(fn));

/** React's shared internals (its current hook dispatcher and element owner), as it hands them to development tools. */
function reactInternals(): { H: unknown; A: unknown } | null {
  const hook = (globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: Map<unknown, { currentDispatcherRef?: unknown }> } }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  for (const r of hook?.renderers?.values?.() ?? []) {
    const ref = r?.currentDispatcherRef as { H?: unknown; A?: unknown } | undefined;
    if (ref && typeof ref === 'object' && 'H' in ref && 'A' in ref) return ref as { H: unknown; A: unknown };
  }
  return null;
}

const failing = {
  getOwner() {
    throw new Error('saywright');
  },
};

/**
 * React 19.0 keeps no record of where JSX was written, but a component's function says where it is: called outside
 * a render, as React's own development build did for its component stacks, it fails on its first hook or the first
 * JSX it creates (React's internals are set to refuse both meanwhile) and the stack names its position. Asked once
 * per component, with the console quiet.
 */
function whereDefined(type: unknown): string | null {
  const fn = renderFunction(type);
  if (!fn) return null;
  const known = defined.get(fn);
  if (known !== undefined) return known;
  let at: string | null = null;
  const E = Error as unknown as { prepareStackTrace?: unknown; stackTraceLimit: number };
  const limit = E.stackTraceLimit;
  const prepare = E.prepareStackTrace;
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = levels.map((k) => console[k]);
  const internals = reactInternals();
  const was = internals && { H: internals.H, A: internals.A };
  try {
    E.stackTraceLimit = 40;
    E.prepareStackTrace = undefined;
    for (const k of levels) console[k] = () => undefined;
    if (internals) {
      internals.H = null;
      internals.A = failing;
    }
    if (isClass(fn)) Reflect.construct(fn, [], Throwing);
    else {
      const out = fn() as { then?: unknown } | null;
      if (out && typeof out.then === 'function') (out as Promise<unknown>).then(undefined, () => undefined);
    }
  } catch (err) {
    at = callerSite(err);
  } finally {
    if (internals && was) {
      internals.H = was.H;
      internals.A = was.A;
    }
    E.stackTraceLimit = limit;
    E.prepareStackTrace = prepare;
    levels.forEach((k, i) => (console[k] = saved[i]));
  }
  defined.set(fn, at);
  return at;
}

/** In the stack of an error from a component called by this script: the component's own frame, the last before ours. */
function callerSite(err: unknown): string | null {
  const stack = err instanceof Error ? err.stack : undefined;
  const me = ownUrl();
  if (!stack || !me) return null;
  let site: string | null = null;
  let entered = false;
  for (const line of stack.split('\n').slice(1)) {
    const f = frameOf(line);
    if (!f) continue;
    if (f.url === me) {
      if (entered) break;
      continue;
    }
    entered = true;
    const p = isLibraryFrame(line) ? null : frameLocation(f.url, true);
    site = p ? `${p}:${f.line}:${f.col}` : null;
  }
  return site;
}
