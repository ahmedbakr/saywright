/**
 * Layers the studio draws itself (the app list, a report, small cards) as real
 * modal dialogs: while open, the rest of the page is inert, focus moves in and
 * stays in, Escape goes to the topmost layer alone, and focus goes back where
 * it was when the layer closes. Both hooks return the ref for the layer's root.
 */
import { useEffect, useRef, useState } from 'react';
import { consumed, keepTabInside, openLayer, tabbables, topLayer } from '@/core/layers';

/** Only the inert background (dialogs built on Radix handle focus and Escape themselves). */
export function useLayer(open: boolean): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || !el) return;
    return openLayer(el);
  }, [open, el]);
  return setEl;
}

export function useModal(
  open: boolean,
  opts: {
    onEscape?: () => void;
    initialFocus?: () => HTMLElement | null | undefined;
    /** Where focus goes on close when what had it before is gone (a menu item, say). */
    returnFocus?: () => HTMLElement | null | undefined;
  } = {},
): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    if (!open || !el) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = openLayer(el);
    if (!el.contains(document.activeElement)) (latest.current.initialFocus?.() ?? tabbables(el)[0] ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (consumed(e) || topLayer() !== el) return;
      if (e.key === 'Escape' && latest.current.onEscape) {
        e.preventDefault();
        latest.current.onEscape();
      } else if (e.key === 'Tab') keepTabInside(e, el);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      close();
      // Back where focus was, unless another layer has taken it meanwhile.
      const now = document.activeElement;
      if (now && now !== document.body && !el.contains(now)) return;
      const usable = (t: HTMLElement | null | undefined) => !!t && t !== document.body && t.isConnected && !t.closest('[inert]');
      const target = usable(returnTo) ? returnTo : latest.current.returnFocus?.();
      if (usable(target)) target!.focus({ preventScroll: true });
    };
  }, [open, el]);
  return setEl;
}
