/**
 * The quick-start tour's state: whether it is on, its step, and the studio as it was when the step began, so the
 * step can move on by itself once the person does what it asks. It starts on its own the first time an app is open,
 * and after that only when asked for (Help, the command palette, Settings). Finished or skipped, it is remembered on
 * this computer by the studio server, so another browser here doesn't bring it back.
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import { useSettings } from './settings';
import { get, set, useStudio } from './store';
import { markOf, stepDone, tourSteps, type TourMark, type TourStep } from './tour-steps';

interface TourState {
  on: boolean;
  step: TourStep;
  /** The studio when this step began. */
  from: TourMark;
  /** Bumped each time the tour starts: its card takes focus then, and only then. */
  started: number;
}

export const useTour = create<TourState>()(() => ({ on: false, step: 'point', from: markOf(get()), started: 0 }));

const steps = () => tourSteps(get().status?.target.hasCode ?? true);

let unwatch: (() => void) | null = null;

/** Each change in the studio: has the person done what this step asks? */
function watch(): void {
  unwatch?.();
  unwatch = useStudio.subscribe((s) => {
    const t = useTour.getState();
    if (t.on && stepDone(t.step, t.from, markOf(s))) tour.next();
  });
}

/** Seen: not shown by itself again, in this browser or another one on this computer. */
function remember(): void {
  useSettings.getState().set({ onboarded: true });
  const status = get().status;
  if (status) set({ status: { ...status, tourSeen: true } });
  void api.put('/tour', { seen: true }).catch(() => undefined);
}

export const tour = {
  /** From the first step. With no app open yet, it waits for one. */
  start(): void {
    useTour.setState((t) => ({ on: true, step: steps()[0], from: markOf(get()), started: t.started + 1 }));
    watch();
  },

  next(): void {
    const t = useTour.getState();
    if (!t.on) return;
    const list = steps();
    const following = list[list.indexOf(t.step) + 1];
    if (!following) return tour.end();
    useTour.setState({ step: following, from: markOf(get()) });
  },

  /** Done, or skipped: either way it is remembered. */
  end(): void {
    if (!useTour.getState().on) return;
    unwatch?.();
    unwatch = null;
    useTour.setState({ on: false });
    remember();
  },
};
