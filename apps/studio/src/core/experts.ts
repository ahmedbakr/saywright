/**
 * Expert reviews in the studio: run the checks in the app's page, add what a
 * crawler and Google's real-user data say, ask the AI expert to judge, show
 * an element a finding is about, and fix findings through the agent.
 */
import { create } from 'zustand';
import type { ElementInfo, ExpertId } from '@saywright/vite/protocol';
import { api } from '@/lib/api';
import { EXPERT_LIST, type AiFinding, type PageReviewRecord, type ReviewCheck } from '@shared/experts';
import { controller } from './controller';
import { get as studio } from './store';

const PICK_KEY = 'saywright.experts';

function readPicked(): ExpertId[] {
  try {
    const v = JSON.parse(localStorage.getItem(PICK_KEY) ?? 'null');
    if (Array.isArray(v) && v.length) return v.filter((x) => ['seo', 'content', 'ux', 'a11y'].includes(x));
  } catch {
    /* default */
  }
  return ['seo', 'content', 'ux', 'a11y'];
}

interface ExpertsStore {
  picked: ExpertId[];
  review: PageReviewRecord | null;
  /** The page the review is for (the studio's frame address). */
  pageUrl: string | null;
  running: boolean;
  /** How far the page's checks have got while they run (0 to 1). */
  progress: number;
  thinking: Partial<Record<ExpertId, boolean>>;
  error: string | null;
}

export const useExperts = create<ExpertsStore>(() => ({ picked: readPicked(), review: null, pageUrl: null, running: false, progress: 0, thinking: {}, error: null }));
const set = useExperts.setState;
const get = useExperts.getState;

/** A finding to fix: from the checks or the AI. */
export type FixItem = { rule: string; title: string; what: string; fix: string; els?: ElementInfo[]; rewrite?: { before: string; after: string } };

export const fromCheck = (c: ReviewCheck): FixItem => ({ rule: c.rule, title: c.title, what: c.what, fix: c.fix, els: c.els });
export const fromAi = (f: AiFinding): FixItem => ({ rule: f.rule, title: f.title, what: f.what, fix: f.fix, els: f.el ? [f.el] : undefined, rewrite: f.rewrite });

export const experts = {
  toggle(id: ExpertId): void {
    const picked = get().picked.includes(id) ? get().picked.filter((x) => x !== id) : [...get().picked, id];
    set({ picked });
    try {
      localStorage.setItem(PICK_KEY, JSON.stringify(picked));
    } catch {
      /* private mode */
    }
  },

  /** The saved review of the page the app shows now, if there is one. */
  async load(): Promise<void> {
    const url = studio().app.url;
    if (!url) return;
    try {
      const { review } = await api.get<{ review: PageReviewRecord | null }>(`/experts/review?url=${encodeURIComponent(url)}`);
      set({ review, pageUrl: url, error: null });
    } catch {
      /* none yet */
    }
  },

  async run(): Promise<void> {
    const picked = get().picked;
    if (!picked.length || get().running) return;
    set({ running: true, progress: 0, error: null });
    try {
      const review = await controller.bridge.review(picked, `${location.origin}/axe.min.js`, (progress) => set({ progress }));
      if (!review) throw new Error('The page couldn’t be checked. Is the app open?');
      const res = await api.post<{ review: PageReviewRecord }>('/experts/review', { review, experts: picked });
      set({ review: res.review, pageUrl: studio().app.url });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ running: false });
    }
  },

  async askAi(expert: ExpertId): Promise<void> {
    const r = get().review;
    if (!r || get().thinking[expert]) return;
    set({ thinking: { ...get().thinking, [expert]: true }, error: null });
    try {
      const res = await api.post<{ review: PageReviewRecord }>('/experts/ai', { url: r.url, expert });
      set({ review: res.review });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ thinking: { ...get().thinking, [expert]: false } });
    }
  },

  /** Select the element a finding is about, scrolled into view. */
  async show(el: ElementInfo): Promise<void> {
    const fresh = await controller.reveal(el);
    if (!fresh) controller.notify('That element isn’t on the page any more. Review the page again.', 'info');
  },

  fix(items: FixItem[], expert: ExpertId): Promise<void> {
    return controller.fixReview(items, EXPERT_LIST.find((e) => e.id === expert)?.label ?? expert);
  },

  async installSkills(): Promise<{ written: string[]; kept: string[]; message?: string } | null> {
    try {
      return await api.post<{ written: string[]; kept: string[]; message?: string }>('/experts/skills', {});
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
};
