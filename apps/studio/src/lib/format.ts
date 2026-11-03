export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Modifier keys as this computer labels them: ⌘ ⌥ ⇧ on a Mac, Ctrl Alt Shift elsewhere. */
const MODIFIERS: Record<string, [mac: string, other: string]> = {
  mod: ['⌘', 'Ctrl'],
  ctrl: ['⌃', 'Ctrl'],
  alt: ['⌥', 'Alt'],
  shift: ['⇧', 'Shift'],
};
const NAMED: Record<string, string> = { enter: '↵', esc: 'Esc', space: 'Space', up: '↑', down: '↓', left: '←', right: '→' };

/** A shortcut's keys, one label each: keys('mod+shift+m') is ⌘ ⇧ M on a Mac and Ctrl Shift M elsewhere. */
export function keys(combo: string, mac = isMac): string[] {
  return combo.split('+').map((k) => {
    const key = k.trim();
    const lower = key.toLowerCase();
    if (MODIFIERS[lower]) return MODIFIERS[lower][mac ? 0 : 1];
    return NAMED[lower] ?? (key.length === 1 ? key.toUpperCase() : key);
  });
}

/** A shortcut as one label: ⌘Z on a Mac (glyphs run together, words keep a space), Ctrl Z elsewhere. */
export function shortcut(combo: string, mac = isMac): string {
  const parts = keys(combo, mac);
  if (!mac) return parts.join(' ');
  return parts.reduce((out, p, i) => out + (i && (p.length > 1 || parts[i - 1].length > 1) ? ' ' : '') + p, '');
}

export function ms(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}${u.hash}`;
    return `${u.host}${path === '/' ? '' : path}`;
  } catch {
    return url;
  }
}

export function fileName(p: string): string {
  return p.split('/').pop() ?? p;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Dollars, to the cent ("<$0.01" for less). */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/** 1.2M, 34K, 512. */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}
