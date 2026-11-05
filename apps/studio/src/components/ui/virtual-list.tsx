/**
 * A long list that puts on the page only the rows near what is in view: the
 * timeline of a long session has thousands, and building them all at once
 * holds the page up for seconds. Rows can be any height: each is measured
 * once shown and estimated until then.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type Key = string | number;

/** The first index whose row ends below `y`. */
function firstBelow(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

export function VirtualList<T>({
  items,
  keyOf,
  estimate,
  render,
  className,
  reveal,
  overscan = 500,
  empty,
}: {
  items: T[];
  keyOf: (x: T) => Key;
  /** Height (px) to assume for a row not measured yet. */
  estimate: (x: T) => number;
  render: (x: T) => ReactNode;
  className?: string;
  /** Bring this row into view whenever it changes. */
  reveal?: Key | null;
  /** How far (px) beyond the visible part to keep rows ready. */
  overscan?: number;
  empty?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<Key, number>());
  const [measured, setMeasured] = useState(0);
  const [view, setView] = useState({ top: 0, height: 900 });
  const frame = useRef(0);

  const offsets = useMemo(() => {
    // oxlint-disable-next-line unicorn/no-new-array -- filled right below; one allocation for long lists
    const o = new Array<number>(items.length + 1);
    o[0] = 0;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyOf and estimate are the caller's (often new each render): offsets follow the items and the heights learnt
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + (heights.current.get(keyOf(items[i])) ?? estimate(items[i]));
    return o;
    // `measured` changes when a row's real height is learnt.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `measured` is that signal: the heights themselves are in a ref
  }, [items, measured]);

  const first = items.length ? firstBelow(offsets, view.top - overscan) : 0;
  let last = first;
  while (last < items.length - 1 && offsets[last + 1] < view.top + view.height + overscan) last++;
  const shown = items.slice(first, last + 1);

  // Learn the real height of the rows on the page: after every render, as rows change; it sets state only when a
  // height did, so it settles.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs after every render on purpose
  useLayoutEffect(() => {
    const rows = inner.current?.children;
    if (!rows) return;
    let changed = false;
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i] as HTMLElement;
      const key = el.dataset.vkey;
      if (key == null) continue;
      const item = shown[i];
      if (!item) continue;
      const h = el.offsetHeight;
      const k = keyOf(item);
      if (h && heights.current.get(k) !== h) {
        heights.current.set(k, h);
        changed = true;
      }
    }
    if (changed) setMeasured((n) => n + 1);
  });

  // Follow the size of the list's box.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight || 900 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);

  // Keep the row asked for in view.
  useLayoutEffect(() => {
    if (reveal == null) return;
    const el = box.current;
    const i = items.findIndex((x) => keyOf(x) === reveal);
    if (!el || i < 0) return;
    const top = offsets[i];
    const bottom = offsets[i + 1];
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - 8);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + 8;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when another row is asked for: the list scrolling on its own isn't a reason to jump back
  }, [reveal]);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = box.current;
      if (el) setView({ top: el.scrollTop, height: el.clientHeight || 900 });
    });
  };

  return (
    <div ref={box} className={className} onScroll={onScroll}>
      {items.length ? (
        <div style={{ position: 'relative', height: offsets[items.length] }}>
          <div ref={inner} style={{ position: 'absolute', top: offsets[first], left: 0, right: 0 }}>
            {shown.map((x) => {
              const k = keyOf(x);
              return (
                <div key={k} data-vkey={k}>
                  {render(x)}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        empty
      )}
    </div>
  );
}
