/**
 * The quick-start tour on the live studio: a card beside what each step is about, and a ring around it. It is not a
 * dialog over the studio: nothing goes inert and focus is never held, so the person does each step on the real UI
 * and the tour moves on by itself (Next always works too). Skip tour, or Escape, ends it. While a dialog, the app
 * list or a report covers the studio, the card steps aside and comes back where it was.
 */
import { motion } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { useApps } from '@/core/apps';
import { controller } from '@/core/controller';
import { consumed, modalOpen } from '@/core/layers';
import { useSessions } from '@/core/sessions';
import { useSettings } from '@/core/settings';
import { get, set, useStudio } from '@/core/store';
import { tour, useTour } from '@/core/tour';
import { escapeEndsTour, placeCard, stepText, tourSteps, type Box, type Side, type TourContext, type TourStep } from '@/core/tour-steps';
import { cn } from '@/lib/cn';
import { isMac } from '@/lib/format';

/** Where a step points: the first of `anchor` that shows (a list: everything in it, as one box), the rings, the sides its card tries. */
interface Spec {
  anchor: (string | string[])[];
  rings: (string | string[])[];
  sides: Side[];
}

const DOCK = ['[data-tour="dock"]', '[data-tour="suggestions"]'];

function specFor(step: TourStep, editing: boolean): Spec {
  switch (step) {
    case 'point':
      return editing ? { anchor: ['[data-tour="frame"]'], rings: [], sides: ['inside'] } : { anchor: ['[data-mode-switcher]'], rings: ['[data-mode-switcher]'], sides: ['bottom'] };
    case 'say':
      return { anchor: [DOCK], rings: [DOCK], sides: ['top'] };
    case 'keep':
      return { anchor: ['[data-island="preview"] .glass', '[data-island] .glass'], rings: ['[data-island="preview"] .glass'], sides: ['bottom'] };
    case 'changes':
      return { anchor: ['[data-change]', '[data-tab="changes"]'], rings: ['[data-tab="changes"]', '[data-change]'], sides: ['left', 'bottom'] };
    case 'ai':
      return { anchor: ['[data-tour="ai"]'], rings: ['[data-tour="ai"]'], sides: ['bottom'] };
    case 'more':
      return { anchor: ['[data-tour="record"]'], rings: ['[data-tour="record"]', ['[data-tab="experts"]', '[data-tab="sessions"]']], sides: ['bottom'] };
    case 'done':
      return { anchor: ['[data-tour="help"]'], rings: [['[data-tour="palette"]', '[data-tour="help"]']], sides: ['bottom'] };
  }
}

/** On screen and not hidden from anyone (a closed panel's tabs, say). */
function shown(el: Element | null): Box | null {
  if (!el || el.closest('[aria-hidden="true"]')) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

function boxOf(target: string | string[]): Box | null {
  const boxes = (Array.isArray(target) ? target : [target]).map((s) => shown(document.querySelector(s))).filter((b): b is Box => !!b);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

interface Layout {
  anchor: Box;
  sides: Side[];
  rings: Box[];
  card: { w: number; h: number };
  view: { w: number; h: number };
}

/** Follows what the step points at every frame: the island morphs, the panel slides, the window resizes. */
function useLayout(spec: Spec | null, card: RefObject<HTMLDivElement | null>): Layout | null {
  const [layout, setLayout] = useState<Layout | null>(null);
  useEffect(() => {
    if (!spec) return setLayout(null);
    let raf = 0;
    let last = '';
    const tick = () => {
      const found = spec.anchor.map(boxOf).find((b): b is Box => !!b);
      // Nothing to point at yet: the card sits in the stage's corner.
      const stage = found ? null : boxOf('[data-stage]');
      const anchor = found ?? stage;
      const next: Layout | null = anchor
        ? {
            anchor,
            sides: found ? spec.sides : ['inside'],
            rings: spec.rings.map(boxOf).filter((b): b is Box => !!b),
            card: { w: card.current?.offsetWidth ?? 340, h: card.current?.offsetHeight ?? 170 },
            view: { w: innerWidth, h: innerHeight },
          }
        : null;
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setLayout(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spec, card]);
  return layout;
}

/** A dialog, the app list, an app opening or a report is over the studio. */
function useCovered(): boolean {
  const studio = useStudio((s) => s.overlay !== null || !s.status?.app);
  const apps = useApps((s) => s.launcher || !!s.opening || !!s.pending);
  const report = useSessions((s) => !!s.open);
  return studio || apps || report;
}

function useTourContext(): TourContext {
  const sample = useStudio((s) => !!s.status?.app?.sample);
  const hasCode = useStudio((s) => s.status?.target.hasCode ?? true);
  const editing = useStudio((s) => s.mode === 'edit');
  const mic = useStudio((s) => s.voice.supported);
  const waiting = useStudio((s) => s.changes.some((c) => c.status === 'preview'));
  const ai = useStudio((s) => s.status?.ai ?? null);
  return { sample, hasCode, editing, mic, waiting, mac: isMac, ai };
}

/** The first time an app shows on this computer, and in this browser, once nothing is over it. */
function useFirstRun(): void {
  const on = useTour((s) => s.on);
  const onboarded = useSettings((s) => s.onboarded);
  const seen = useStudio((s) => (s.status ? s.status.tourSeen !== false : true));
  const showing = useStudio((s) => !!s.status?.app && s.app.connected);
  const covered = useCovered();
  useEffect(() => {
    if (on || onboarded || seen || !showing || covered || location.pathname.startsWith('/report/')) return;
    const t = setTimeout(() => tour.start(), 600);
    return () => clearTimeout(t);
  }, [on, onboarded, seen, showing, covered]);
}

export function Tour() {
  useFirstRun();
  const on = useTour((s) => s.on);
  return on ? <Coach /> : null;
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function skip(): void {
  tour.end();
  controller.notify('Tour closed. Take it again any time from Help (?).', 'info');
}

function Coach() {
  const step = useTour((s) => s.step);
  const started = useTour((s) => s.started);
  const covered = useCovered();
  const c = useTourContext();
  const steps = tourSteps(c.hasCode);
  const index = Math.max(0, steps.indexOf(step));
  const last = index === steps.length - 1;
  const text = stepText(step, c);
  // Steps that move on when you do the thing: Next is only the way past them.
  const acts = step === 'point' || step === 'say' || step === 'keep';
  const card = useRef<HTMLDivElement>(null);
  const spec = useSameSpec(covered ? null : specFor(step, c.editing));
  const layout = useLayout(spec, card);
  const place = layout ? placeCard(layout.anchor, layout.card, layout.view, layout.sides) : null;
  const placed = !!place;
  const id = useId();

  // Changes and the panel's own tools are in the panel: show it.
  useEffect(() => {
    if (step === 'changes') useSettings.getState().setUi({ panelOpen: true, panelTab: 'changes' });
    else if (step === 'more') useSettings.getState().setUi({ panelOpen: true });
  }, [step]);

  // Starting, the card takes focus (and says what it is); afterwards focus stays where the person is working. A dialog
  // that covered the card hands focus back to nowhere once it has faded out (the card wasn't there): the card takes it.
  const focused = useRef(0);
  useEffect(() => {
    if (!placed || covered) return;
    if (focused.current !== started) {
      focused.current = started;
      card.current?.focus({ preventScroll: true });
      return;
    }
    let raf = 0;
    const until = performance.now() + 1000;
    const check = () => {
      if (!document.activeElement || document.activeElement === document.body) card.current?.focus({ preventScroll: true });
      else if (performance.now() < until) raf = requestAnimationFrame(check);
    };
    check();
    return () => cancelAnimationFrame(raf);
  }, [placed, covered, started]);
  // Ended with focus in the card: to Help, where the tour can be taken again (before the card goes).
  useLayoutEffect(
    () => () => {
      if (card.current?.contains(document.activeElement)) document.querySelector<HTMLElement>('[data-tour="help"]')?.focus({ preventScroll: true });
    },
    [],
  );

  // Screen readers hear each new step (the first one, as the card takes focus).
  const [said, setSaid] = useState('');
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (announced.current !== started) {
      announced.current = started;
      return;
    }
    setSaid(`Step ${index + 1} of ${steps.length}: ${text.title}. ${text.body}`);
  }, [step, started]);

  // Escape ends the tour, unless the studio is running something Escape stops; text fields keep their own Escape.
  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || consumed(e) || modalOpen()) return;
      const inCard = !!card.current?.contains(document.activeElement);
      if (!inCard && (typing(e.target) || !escapeEndsTour(get()))) return;
      e.preventDefault();
      skip();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [covered]);

  return (
    <>
      <div role="status" className="sr-only">
        {said}
      </div>
      {layout?.rings.map((r, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none fixed z-[44] rounded-[10px]"
          style={{ left: r.x - 4, top: r.y - 4, width: r.w + 8, height: r.h + 8, boxShadow: '0 0 0 2px var(--human), 0 0 0 6px var(--human-soft)', animation: 'rec-pulse 1.8s ease-in-out infinite' }}
          data-tour-ring
        />
      ))}
      {!covered && (
        <div
          ref={card}
          role="dialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-body`}
          tabIndex={-1}
          className="fixed z-[45] w-[340px] max-w-[calc(100vw-24px)] rounded-[14px] bg-panel p-4 shadow-pop outline-none"
          style={{ left: place?.x ?? 0, top: place?.y ?? 0, visibility: place ? 'visible' : 'hidden' }}
          onKeyDown={ownKeys}
          data-tour-card={step}
        >
          {place && <Arrow side={place.side} at={place.arrow} />}
          <motion.div key={step} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
            <div className="text-[11.5px] font-medium tabular-nums text-fg-3">
              {index + 1} of {steps.length}
            </div>
            <h2 id={`${id}-title`} className="mt-1 text-[14.5px] font-semibold tracking-[-0.01em] text-fg">
              {text.title}
            </h2>
            <p id={`${id}-body`} className="mt-1 text-[12.5px] leading-relaxed text-fg-2">
              {text.body}
            </p>
          </motion.div>
          <div className="mt-3.5 flex items-center gap-1.5">
            {!last && (
              <Button variant="ghost" onClick={skip} className="-ms-2" data-tour-skip>
                Skip tour
              </Button>
            )}
            <span className="flex-1" />
            {step === 'say' && c.mic && (
              <Button variant="ghost" onClick={() => set({ overlay: 'onboarding', onboardingStep: 4 })}>
                Check your mic
              </Button>
            )}
            {step === 'ai' && !c.ai?.ready && (
              <Button
                variant="secondary"
                onClick={() => {
                  tour.next();
                  set({ overlay: 'settings', settingsTab: 'ai' });
                }}
              >
                Connect an AI
              </Button>
            )}
            <Button variant={acts ? 'secondary' : 'primary'} onClick={() => tour.next()} data-tour-next>
              {last ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** A key pressed on the card's buttons is theirs: Space doesn't start talking, Enter doesn't keep a preview. */
function ownKeys(e: ReactKeyboardEvent): void {
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement && e.target.closest('button')) e.stopPropagation();
}

/** The same spec object while the step and mode stay the same, so the layout loop doesn't restart every render. */
function useSameSpec(spec: Spec | null): Spec | null {
  const ref = useRef<{ key: string; spec: Spec | null }>({ key: '', spec: null });
  const key = JSON.stringify(spec);
  if (ref.current.key !== key) ref.current = { key, spec };
  return ref.current.spec;
}

const ARROW_EDGE: Record<Exclude<Side, 'inside'>, string> = {
  bottom: 'border-l border-t',
  top: 'border-b border-r',
  left: 'border-r border-t',
  right: 'border-b border-l',
};

/** The card's point, on the edge facing what it is about. */
function Arrow({ side, at }: { side: Side; at: number | null }) {
  if (at === null || side === 'inside') return null;
  const style: CSSProperties = side === 'bottom' ? { top: -5, left: at - 5 } : side === 'top' ? { bottom: -5, left: at - 5 } : side === 'left' ? { right: -5, top: at - 5 } : { left: -5, top: at - 5 };
  return <span aria-hidden className={cn('absolute size-2.5 rotate-45 border-line-strong bg-panel', ARROW_EDGE[side])} style={style} />;
}
