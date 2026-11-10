/**
 * Expert reviews: the page's own checks (from the bridge), what a crawler
 * sees (for SEO), and, when asked, the AI expert's judgement grounded in the
 * expert's rules. One record per page, kept with the app's data.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ElementInfo, ExpertId, PageReview } from '@saywright/vite/protocol';
import type { AiFinding, ExpertAi, FieldData, PageReviewRecord, ReviewCheck, ReviewSummary } from '../../shared/experts.ts';
import type { JsonRequest } from '../ai/service.ts';
import { writeFileAtomic } from '../fsx.ts';
import { crawl } from './crawl.ts';
import { EXPERTS, systemPromptFor } from './instructions.ts';

const SEVERITY = z.enum(['blocker', 'high', 'medium', 'low', 'info']);

export const ExpertAnswer = z.object({
  summary: z.string().describe('Two or three sentences: the state of the page for this expert, most important first.'),
  verdicts: z
    .array(
      z.object({
        check: z.string().describe('The check key, e.g. c3.'),
        verdict: z.enum(['confirmed', 'dismissed']),
        note: z.string().describe('One sentence: why it matters here, or why it is harmless here.'),
      }),
    )
    .describe('One entry per check listed.'),
  findings: z
    .array(
      z.object({
        rule: z.string().describe('The rule it stands on (e.g. SEO-17, CNT-06, UX-13, WCAG 1.3.1), or "heuristic".'),
        severity: SEVERITY,
        title: z.string(),
        what: z.string().describe('What the page shows, as evidence.'),
        fix: z.string().describe('The concrete change.'),
        element: z.string().optional().describe('The id of the element it is about (e3), when one is listed.'),
        before: z.string().optional().describe('For wording: the current text.'),
        after: z.string().optional().describe('For wording: the suggested text.'),
      }),
    )
    .describe('Up to 8 findings of your own that the checks can’t judge.'),
});

/**
 * One review per page: its address without the query, and with its #/route when the app routes by hash
 * (/#/shop and /#/checkout are different pages; a plain #anchor is the same page).
 */
export const pageKey = (url: string) => {
  try {
    const u = new URL(url);
    const route = /^#!?\//.test(u.hash) ? u.hash.split('?')[0] : '';
    return crypto.createHash('sha1').update(`${u.origin}${u.pathname}${route}`).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  }
};

export class ReviewStore {
  constructor(private dir: string) {}

  private file(key: string) {
    return path.join(this.dir, `${key}.json`);
  }

  get(url: string): PageReviewRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(pageKey(url)), 'utf8')) as PageReviewRecord;
    } catch {
      return null;
    }
  }

  save(r: PageReviewRecord): void {
    writeFileAtomic(this.file(r.key), JSON.stringify(r));
  }

  list(): ReviewSummary[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: ReviewSummary[] = [];
    for (const n of names) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')) as PageReviewRecord;
        const counts: ReviewSummary['counts'] = {};
        for (const c of r.checks) counts[c.severity] = (counts[c.severity] ?? 0) + 1;
        out.push({ key: r.key, url: r.url, at: r.at, counts });
      } catch {
        /* a torn file */
      }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 50);
  }
}

/** A review from the page's checks, with what a crawler sees for SEO. `realUrl`: the page's own address (not the studio's proxy). */
export async function reviewPage(store: ReviewStore, review: PageReview, experts: ExpertId[], realUrl: string): Promise<PageReviewRecord> {
  const started = Date.now();
  const checks = [...review.checks];
  let crawlSummary: PageReviewRecord['crawl'] = null;
  if (experts.includes('seo') && /^https?:/.test(realUrl)) {
    const c = await crawl(realUrl);
    checks.unshift(...c.checks);
    crawlSummary = {
      status: c.facts.status,
      finalUrl: c.facts.finalUrl,
      redirects: c.facts.redirects.length,
      local: c.facts.local,
      robots: c.facts.robots ? { status: c.facts.robots.status, blocks: c.facts.robots.blocks } : null,
      sitemap: c.facts.sitemap,
    };
  }
  const previous = store.get(realUrl);
  const record: PageReviewRecord = {
    key: pageKey(realUrl),
    url: realUrl,
    at: Date.now(),
    experts,
    facts: { ...review.facts, url: realUrl },
    checks: checks.map((c, i): ReviewCheck => ({ ...c, key: `c${i + 1}` })),
    crawl: crawlSummary,
    // An AI review of an expert not checked again this time stays.
    ai: Object.fromEntries(Object.entries(previous?.ai ?? {}).filter(([e]) => !experts.includes(e as ExpertId))),
    ms: review.ms + (Date.now() - started),
    field: previous?.field,
  };
  store.save(record);
  return record;
}

/** The page as the AI expert reads it: facts, the elements it may point at, the checks and the field data. */
export function expertPrompt(r: PageReviewRecord, expert: ExpertId): { text: string; elements: ElementInfo[] } {
  const f = r.facts;
  const elements: ElementInfo[] = [];
  const seen = new Set<number>();
  const ref = (el: ElementInfo) => {
    if (!seen.has(el.id)) {
      seen.add(el.id);
      elements.push(el);
    }
    return `e${elements.findIndex((e) => e.id === el.id) + 1}`;
  };
  const described = (e: ElementInfo) => `${ref(e)} ${e.tag}${e.role ? ` (${e.role})` : ''} “${(e.text || e.label).slice(0, 60)}”${e.src ? ` at ${e.src}` : ''}`;
  // Each check with its evidence on its own lines: the elements it found (a sample when there are more) and their HTML.
  const checks = r.checks.filter((c) => c.expert === expert);
  const checkLines = checks.map((c) => {
    const els = (c.els ?? []).slice(0, 3);
    const total = Math.max(c.count ?? 0, c.els?.length ?? 0);
    return [
      `${c.key} [${c.rule}] (${c.severity}) ${c.title}. ${c.what}`,
      els.length ? `   Evidence (${els.length === total ? `${total} element${total > 1 ? 's' : ''}` : `${els.length} of ${total} elements`}): ${els.map(described).join('; ')}` : '',
      ...(c.html ?? []).slice(0, 2).map((h) => `   ${h}`),
    ]
      .filter(Boolean)
      .join('\n');
  });
  const onChecks = new Set(elements.map((e) => e.id));
  for (const el of f.elements ?? []) ref(el);
  // What the other experts already cover: each problem is reported once, by the expert whose area it is.
  const others = (Object.keys(EXPERTS) as ExpertId[]).filter((x) => x !== expert);
  const covered = [
    ...r.checks.filter((c) => c.expert !== expert).map((c) => `[${EXPERTS[c.expert].label}] ${c.title}`),
    ...others.flatMap((x) => (r.ai[x]?.findings ?? []).map((g) => `[${EXPERTS[x].label}] ${g.title}`)),
  ].filter((t, i, all) => all.indexOf(t) === i);
  const lines = [
    `<page url="${f.url}">`,
    `Title: ${f.title || '(none)'}`,
    `Meta description: ${f.description ?? '(none)'}`,
    `Canonical: ${f.canonical ?? '(none)'} · Robots: ${f.robots ?? '(none)'} · lang="${f.lang ?? ''}" dir="${f.dir ?? ''}" · Viewport: ${f.viewport ?? '(none)'}`,
    `Headings:\n${f.headings.map((h) => `${'  '.repeat(h.level - 1)}H${h.level} ${h.text}`).join('\n') || '(none)'}`,
    Object.keys(f.og).length ? `Social tags: ${Object.entries(f.og).map(([k, v]) => `${k}=${v.slice(0, 80)}`).join('; ')}` : 'Social tags: (none)',
    `Structured data: ${f.jsonLd.join(', ') || '(none)'}`,
    `Words: ${f.words}. Links: ${f.links.internal} internal, ${f.links.external} external. Images: ${f.images}.`,
    f.readability ? `Readability: ${f.readability.lang === 'en' ? `Flesch reading ease ${f.readability.ease}, grade ${f.readability.grade}, ` : ''}${f.readability.sentence} words per sentence.` : '',
    f.forms.length ? `Form fields (label [type, then what is set: autocomplete, inputmode, required]): ${f.forms.map((x) => `${x.label || '(no label)'} [${x.type}${x.autocomplete ? `, autocomplete=${x.autocomplete}` : ''}${x.inputmode ? `, inputmode=${x.inputmode}` : ''}${x.required ? ', required' : ''}]`).join('; ')}` : '',
    f.buttons.length ? `Buttons (named as a screen reader names them): ${f.buttons.map((b) => (b === '(no name)' ? b : `“${b}”`)).join(', ')}` : '',
    f.landmarks ? `Landmarks: ${f.landmarks.map((l) => `${l.role}${l.name ? ` “${l.name}”` : ''}`).join(', ') || '(none)'}` : 'Landmarks: (not collected: don’t judge them)',
    f.live ? `Live regions on the page now: ${f.live.map((l) => `${l.role} “${l.text}”`).join(', ') || '(none; one that appears later, like a toast, isn’t listed)'}` : 'Live regions: (not collected: don’t judge them)',
    f.linkTargets?.length ? `Links (named as a screen reader names them → where they go, as written): ${f.linkTargets.map((l) => `${l.text === '(no name)' ? l.text : `“${l.text}”`} → ${l.href}`).join(' · ')}` : '',
    f.lcp != null || f.cls != null ? `Measured in this browser (lab): LCP ${f.lcp ?? '?'} ms, CLS ${f.cls ?? '?'}` : '',
    r.crawl ? `Crawl: status ${r.crawl.status}, ${r.crawl.redirects} redirect(s)${r.crawl.local ? ', on this computer (robots.txt and sitemap not checked)' : `, robots.txt ${r.crawl.robots?.status ?? '?'}${r.crawl.robots?.blocks ? ' (blocks this page)' : ''}, sitemap ${r.crawl.sitemap ? `${r.crawl.sitemap.status}, ${r.crawl.sitemap.urls} URLs` : 'none'}`}` : '',
    fieldLines(r.field),
    `Main text (shortened; text shown only after an action, like an error message, isn’t in it):\n${f.text.slice(0, 3000)}`,
    '</page>',
    elements.some((e) => !onChecks.has(e.id)) ? `<elements>\n${elements.filter((e) => !onChecks.has(e.id)).map((e) => described(e).replace(' ', ': ')).join('\n')}\n</elements>` : '',
    `<checks expert="${EXPERTS[expert].label}">\n${checkLines.join('\n') || '(no problems found by the checks)'}\n</checks>`,
    covered.length ? `<covered_by_other_experts>\n${covered.slice(0, 20).join('\n')}\n</covered_by_other_experts>` : '',
    `Review this page as the ${EXPERTS[expert].label} expert. Say something is missing only when the facts above show it is.`,
  ];
  return { text: lines.filter(Boolean).join('\n'), elements };
}

function fieldLines(field: FieldData | undefined): string {
  if (!field) return '';
  const out: string[] = [];
  const c = field.crux;
  if (c) out.push(`Real users (Chrome UX Report, ${c.scope === 'url' ? 'this page' : 'the whole site'}, phones, 75th percentile): LCP ${c.lcp ?? '?'} ms, INP ${c.inp ?? '?'} ms, CLS ${c.cls ?? '?'}`);
  const s = field.search;
  if (s) out.push(`Google Search, 28 days: ${s.clicks} clicks, ${s.impressions} impressions, CTR ${(s.ctr * 100).toFixed(1)}%, average position ${s.position.toFixed(1)}. Top queries: ${s.queries.slice(0, 10).map((q) => `“${q.query}” (${q.clicks} clicks, ${q.impressions} impressions, position ${q.position.toFixed(1)})`).join('; ')}`);
  const a = field.analytics;
  if (a) out.push(`Analytics, 28 days: ${a.views} views by ${a.users} users, engagement rate ${(a.engagementRate * 100).toFixed(0)}%, ${Math.round(a.avgEngagementSec)} s average engagement.`);
  return out.join('\n');
}

/** The AI expert's judgement of the page, saved with the review. */
export async function aiReview(store: ReviewStore, r: PageReviewRecord, expert: ExpertId, ask: <T>(req: JsonRequest<T>) => Promise<{ value: T; model: string }>, cwd?: string): Promise<PageReviewRecord> {
  const { text, elements } = expertPrompt(r, expert);
  const { value, model } = await ask({
    task: 'report',
    feature: 'review',
    system: systemPromptFor(expert),
    parts: [{ type: 'text', text }],
    schema: ExpertAnswer,
    name: 'expert_review',
    maxTokens: 6000,
    effort: 'medium',
    cwd,
  });
  const keys = new Set(r.checks.filter((c) => c.expert === expert).map((c) => c.key));
  const verdicts: ExpertAi['verdicts'] = {};
  for (const v of value.verdicts) if (keys.has(v.check)) verdicts[v.check] = { verdict: v.verdict, note: v.note };
  const findings: AiFinding[] = value.findings.slice(0, 8).map((x) => {
    const n = x.element ? Number(/^e(\d+)$/.exec(x.element.trim())?.[1]) : NaN;
    const el = Number.isFinite(n) ? elements[n - 1] : undefined;
    return {
      rule: x.rule,
      severity: x.severity,
      title: x.title,
      what: x.what,
      fix: x.fix,
      ...(el ? { el } : {}),
      ...(x.before && x.after && x.before !== x.after ? { rewrite: { before: x.before, after: x.after } } : {}),
    };
  });
  // Into the review as it is now: another expert's answer may have been saved meanwhile.
  const now = store.get(r.url);
  const base = now?.key === r.key ? now : r;
  // The verdicts are about these checks: not about a review of the page run again since.
  const updated: PageReviewRecord = { ...base, ai: { ...base.ai, [expert]: { summary: value.summary, verdicts: base.at === r.at ? verdicts : {}, findings: unrepeated(findings, base, expert), model, at: Date.now() } } };
  store.save(updated);
  return updated;
}

/** A title's significant words, to tell whether two experts found the same thing. */
const wordsOf = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)));

function alike(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const both = Array.from(x).filter((w) => y.has(w)).length;
  return both / (x.size + y.size - both || 1);
}

/** Without what another expert already reported (much the same words, about the same element): each problem once. */
function unrepeated(findings: AiFinding[], r: PageReviewRecord, expert: ExpertId): AiFinding[] {
  const theirs = (Object.keys(r.ai) as ExpertId[]).filter((x) => x !== expert).flatMap((x) => r.ai[x]?.findings ?? []);
  const same = (f: AiFinding, g: AiFinding) => {
    const s = alike(f.title, g.title);
    return s >= 0.75 || (s >= 0.5 && !!f.el && !!g.el && f.el.src === g.el.src && f.el.text === g.el.text);
  };
  return findings.filter((f) => !theirs.some((g) => same(f, g)));
}

/** A skill file the studio wrote: its frontmatter says it comes from Saywright (`skillFile` puts it there). */
const fromStudio = (text: string) => /^---\r?\n(?:(?!---\r?\n)[^\n]*\n)*?\s+source: Saywright\r?\n/.test(text);

/**
 * The experts as Agent Skills in the app's folder, for the person's own coding agent. A file the studio wrote
 * before is brought up to date; a file of the same name that the person wrote is left as it is (`kept`), since
 * a team's own `seo-audit` skill is theirs and replacing it would lose their work without a word.
 */
export function installSkills(root: string, skills: { id: ExpertId; text: string }[]): { written: string[]; kept: string[] } {
  const dirs = ['.agents/skills'];
  if (fs.existsSync(path.join(root, '.claude'))) dirs.push('.claude/skills');
  const written: string[] = [];
  const kept: string[] = [];
  for (const d of dirs) {
    for (const s of skills) {
      const rel = path.join(d, EXPERTS[s.id].skill, 'SKILL.md');
      const file = path.join(root, rel);
      const shown = rel.split(path.sep).join('/');
      let before: string | null = null;
      try {
        before = fs.readFileSync(file, 'utf8');
      } catch {
        // Not there yet (or not a file we can read: writing below says so).
      }
      if (before !== null && before !== s.text && !fromStudio(before)) {
        kept.push(shown);
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, s.text);
      written.push(shown);
    }
  }
  return { written, kept };
}

/** What to tell the person about the skill files left alone, by name; nothing when every file was written. */
export function skillsAnswer(r: { written: string[]; kept: string[] }): string | undefined {
  if (!r.kept.length) return undefined;
  const names = r.kept.join(', ');
  return r.kept.length === 1
    ? `Left ${names} as it is: a skill of that name is already there and the studio didn’t write it. Rename or move it to add the studio’s.`
    : `Left ${names} as they are: skills of those names are already there and the studio didn’t write them. Rename or move them to add the studio’s.`;
}
