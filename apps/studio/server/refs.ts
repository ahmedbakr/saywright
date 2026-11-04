/**
 * The elements a person points at, as the studio's page (or an AI app over MCP) describes them: kept to what the
 * server needs and can trust. A source location is any relative path inside the project (Next.js folders like
 * "app/(main)/users/[id]" included), or in a sibling package of the workspace (monorepo) the app is part of
 * ("../packages/ui/Button.tsx"); where it really leads is checked again whenever it is read (Project.resolve).
 */
import { parseSrc, type SourceHint } from '@saywright/vite/protocol';
import type { RefInfo } from '../shared/api.ts';
import { frameList } from './trace.ts';

/** "file:line:col" with a relative path that stays inside the project or its workspace, or null. */
export function cleanSrc(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 400) return null;
  const at = parseSrc(v);
  if (!at || at.line < 1 || at.col < 1) return null;
  const file = at.file;
  // No absolute paths, drive letters or addresses (C:\…, https://…), no control characters, no queries.
  // oxlint-disable-next-line no-control-regex -- control characters are what it turns away
  if (!file || file.startsWith('/') || /^[a-z][\w+.-]*:/i.test(file) || /[\0-\x1f\\?#]/.test(file)) return null;
  // Steps out only at the start, towards the workspace's other packages.
  const parts = file.split('/');
  const from = parts.findIndex((part) => part !== '..');
  if (from < 0 || parts.slice(from).some((part) => part === '..' || part === '.' || part === '')) return null;
  return v;
}

/** A location already in the project's source (rather than in a bundle that source maps lead back from). */
export function sanitizeRefs(raw: unknown): RefInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const ref: RefInfo = {
      role: str(o.role, 20) || 'this',
      src: cleanSrc(o.src),
      name: str(o.name, 80) || 'element',
      label: str(o.label, 120),
      text: str(o.text, 200),
      tag: str(o.tag, 30) || undefined,
    };
    // What identifies it and where React's development build said it came from, kept with a place too: tracing it
    // again (MCP's get_context) tells it from its look-alikes as the Inspector did.
    const hint = sanitizeHint(o.hint);
    if (hint) ref.hint = hint;
    const frames = frameList(o.frames);
    if (frames.length) ref.frames = frames;
    if (typeof o.same === 'number' && Number.isInteger(o.same) && o.same > 1) ref.same = Math.min(o.same, 1_000_000);
    return ref;
  });
}

function sanitizeHint(raw: unknown): SourceHint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const h = raw as { attrs?: unknown; file?: unknown };
  const attrs: Record<string, string> = {};
  if (h.attrs && typeof h.attrs === 'object') {
    for (const [k, v] of Object.entries(h.attrs as Record<string, unknown>).slice(0, 16)) if (/^[\w:-]{1,30}$/.test(k) && typeof v === 'string') attrs[k] = v.slice(0, 200);
  }
  const file = typeof h.file === 'string' && h.file.length <= 400 ? h.file : undefined;
  return file ? { attrs, file } : { attrs };
}
