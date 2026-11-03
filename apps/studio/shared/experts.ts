/**
 * Expert reviews of a page (SEO, content, UI/UX, accessibility): what the
 * checks found, what a crawler sees, and what the AI expert confirmed,
 * dismissed or added.
 */
import type { CheckSeverity, ElementInfo, ExpertId, PageCheck, PageFacts } from '@saywright/vite/protocol';

export type { CheckSeverity, ExpertId, PageCheck, PageFacts };

export const EXPERT_LIST: { id: ExpertId; label: string; hint: string }[] = [
  { id: 'seo', label: 'SEO', hint: 'Indexing, titles, links, structured data, speed (Google Search Central).' },
  { id: 'content', label: 'Content', hint: 'Clarity, reading level, buttons, errors, Arabic and right-to-left text.' },
  { id: 'ux', label: 'UI/UX', hint: 'Forms, targets, feedback, layout and the usability heuristics.' },
  { id: 'a11y', label: 'Accessibility', hint: 'WCAG 2.2 AA with axe-core: names, contrast, keyboard, labels.' },
];

export const SEVERITY_ORDER: CheckSeverity[] = ['blocker', 'high', 'medium', 'low', 'info'];

/** A check with its place in the review, for the AI to refer to. */
export interface ReviewCheck extends PageCheck {
  key: string;
}

interface CrawlSummary {
  status: number | null;
  finalUrl: string;
  redirects: number;
  local: boolean;
  robots: { status: number; blocks: boolean } | null;
  sitemap: { url: string; status: number; urls: number; listsPage: boolean | null } | null;
}

/** Something the AI expert found that the checks can't judge. */
export interface AiFinding {
  rule: string;
  severity: CheckSeverity;
  title: string;
  what: string;
  fix: string;
  el?: ElementInfo;
  rewrite?: { before: string; after: string };
}

export interface ExpertAi {
  summary: string;
  /** By check key: confirmed (it matters here) or dismissed (harmless here), with why. */
  verdicts: Record<string, { verdict: 'confirmed' | 'dismissed'; note: string }>;
  findings: AiFinding[];
  model: string;
  at: number;
}

export interface PageReviewRecord {
  /** One per page (its address without query or fragment). */
  key: string;
  url: string;
  at: number;
  experts: ExpertId[];
  facts: PageFacts;
  checks: ReviewCheck[];
  crawl: CrawlSummary | null;
  ai: Partial<Record<ExpertId, ExpertAi>>;
  ms: number;
  /** Real-user data from the connected services, when there is any. */
  field?: FieldData;
}

/** From Google's services, for the page's public address. */
export interface FieldData {
  /** Chrome UX Report: 75th percentile over 28 days, phones. */
  crux?: { lcp: number | null; inp: number | null; cls: number | null; scope: 'url' | 'origin'; period: string } | null;
  /** Search Console, last 28 days. */
  search?: { clicks: number; impressions: number; ctr: number; position: number; queries: { query: string; clicks: number; impressions: number; position: number }[] } | null;
  /** Google Analytics 4, last 28 days. */
  analytics?: { views: number; users: number; engagementRate: number; avgEngagementSec: number } | null;
  errors?: string[];
}

export interface ReviewSummary {
  key: string;
  url: string;
  at: number;
  counts: Partial<Record<CheckSeverity, number>>;
}
