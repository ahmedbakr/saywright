import { ChevronRight, Crosshair, ExternalLink, Gauge, Search, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { experts, fromAi, fromCheck, useExperts, type FixItem } from '@/core/experts';
import { set as setStudio, useStudio } from '@/core/store';
import { useAiName } from '@/lib/ai-name';
import { cn } from '@/lib/cn';
import { ago, compact, shortUrl } from '@/lib/format';
import { EXPERT_LIST, SEVERITY_ORDER, type AiFinding, type CheckSeverity, type ExpertId, type PageReviewRecord, type ReviewCheck } from '@shared/experts';

const SEV: Record<CheckSeverity, { label: string; dot: string; text: string }> = {
  blocker: { label: 'Blocker', dot: 'bg-bad', text: 'text-bad' },
  high: { label: 'High', dot: 'bg-bad/70', text: 'text-bad' },
  medium: { label: 'Medium', dot: 'bg-warn', text: 'text-warn' },
  low: { label: 'Low', dot: 'bg-fg-3', text: 'text-fg-2' },
  info: { label: 'Info', dot: 'bg-line-strong', text: 'text-fg-3' },
};

const rank = (s: CheckSeverity) => SEVERITY_ORDER.indexOf(s);

function Dot({ s }: { s: CheckSeverity }) {
  return <span className={cn('mt-[5px] size-[7px] shrink-0 rounded-full', SEV[s].dot)} />;
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-block h-[18px] shrink-0 rounded-[5px] bg-sunken px-1.5 font-mono text-[10.5px] leading-[18px] text-fg-3', className)}>{children}</span>;
}

/** One finding: a check from the page, or the AI's own. */
function Finding({
  severity,
  title,
  rule,
  what,
  fix,
  html,
  wcag,
  source,
  verdict,
  rewrite,
  item,
  expert,
  count,
  fromAi,
}: {
  severity: CheckSeverity;
  title: string;
  rule: string;
  what: string;
  fix: string;
  html?: string[];
  wcag?: string[];
  source?: string;
  verdict?: { verdict: 'confirmed' | 'dismissed'; note: string };
  rewrite?: { before: string; after: string };
  item: FixItem;
  expert: ExpertId;
  count?: number;
  /** Found by the AI expert, not by a check. */
  fromAi?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ai = useAiName();
  const dismissed = verdict?.verdict === 'dismissed';
  const el = item.els?.[0];
  return (
    <div className={cn('border-t border-line first:border-0', dismissed && 'opacity-55')} data-finding={rule}>
      <button className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-hover/60" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Dot s={severity} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] leading-snug text-fg">
            {fromAi && <Sparkles className="mr-1 inline size-3 -translate-y-px text-ai" aria-label={`Found by ${ai}`} />}
            {title}
            {count && count > 1 ? <span className="text-fg-3"> · {count}</span> : null}
          </span>
          {verdict && <span className={cn('mt-0.5 block text-[11.5px] leading-snug', dismissed ? 'text-fg-3' : 'text-ai-fg')}>{dismissed ? 'Dismissed' : 'Confirmed'}: {verdict.note}</span>}
        </span>
        <Pill className="mt-[1px] max-w-[112px] truncate">{rule.replace(/^axe:/, '')}</Pill>
        <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-[30px] text-[12px] leading-relaxed">
          <p className="text-fg-2">{what}</p>
          {rewrite ? (
            <div className="space-y-1 rounded-[8px] bg-sunken p-2">
              <div className="text-fg-3 line-through decoration-fg-3/50">{rewrite.before}</div>
              <div className="text-fg">{rewrite.after}</div>
            </div>
          ) : (
            <p className="text-fg">
              <span className="text-fg-3">Fix: </span>
              {fix}
            </p>
          )}
          {html?.length ? <pre tabIndex={0} role="region" aria-label="The elements’ HTML" className="max-h-[96px] overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-sunken p-2 font-mono text-[10.5px] text-fg-3">{html.join('\n')}</pre> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {wcag?.map((w) => (
              <Pill key={w}>WCAG {w}</Pill>
            ))}
            {source && (
              <a href={source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11.5px] text-human-fg hover:underline">
                Rule <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          <div className="flex gap-1.5 pt-0.5">
            {el && (
              <Button size="sm" variant="ghost" icon={<Crosshair />} onClick={() => void experts.show(el)}>
                Show
              </Button>
            )}
            <Button size="sm" variant="ai" icon={<Sparkles />} onClick={() => void experts.fix([item], expert)} disabled={dismissed}>
              Fix with {ai}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldCard({ r }: { r: PageReviewRecord }) {
  const f = r.field;
  if (!f || (!f.crux && !f.search && !f.analytics && !f.errors?.length)) return null;
  const grade = (v: number | null, good: number, poor: number) => (v == null ? 'text-fg-3' : v <= good ? 'text-ok' : v > poor ? 'text-bad' : 'text-warn');
  return (
    <div className="space-y-1.5 rounded-[10px] px-3 py-2.5 text-[12px] ring-1 ring-inset ring-line" data-field>
      {f.crux && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Gauge className="size-3.5 text-fg-3" />
          <span className="text-fg-3">Real users{f.crux.scope === 'origin' ? ' (whole site)' : ''}:</span>
          <span className={grade(f.crux.lcp, 2500, 4000)}>LCP {f.crux.lcp != null ? `${(f.crux.lcp / 1000).toFixed(1)} s` : '—'}</span>
          <span className={grade(f.crux.inp, 200, 500)}>INP {f.crux.inp != null ? `${f.crux.inp} ms` : '—'}</span>
          <span className={grade(f.crux.cls, 0.1, 0.25)}>CLS {f.crux.cls ?? '—'}</span>
        </div>
      )}
      {f.search && (
        <div className="flex items-start gap-2.5">
          <Search className="mt-[2px] size-3.5 shrink-0 text-fg-3" />
          <span className="text-fg-2">
            {compact(f.search.clicks)} clicks · {compact(f.search.impressions)} impressions · position {f.search.position.toFixed(1)}
            {f.search.queries.length ? <span className="text-fg-3"> · {f.search.queries.slice(0, 3).map((q) => `“${q.query}”`).join(', ')}</span> : null}
          </span>
        </div>
      )}
      {f.analytics && (
        <div className="text-fg-2">
          <span className="text-fg-3">Analytics:</span> {compact(f.analytics.views)} views · {compact(f.analytics.users)} users · {Math.round(f.analytics.engagementRate * 100)}% engaged
        </div>
      )}
      {f.errors?.map((e) => (
        <div key={e} className="text-[11.5px] text-warn">
          {e}
        </div>
      ))}
    </div>
  );
}

function ExpertSection({ r, expert, label }: { r: PageReviewRecord; expert: ExpertId; label: string }) {
  const thinking = useExperts((s) => !!s.thinking[expert]);
  const ai = useAiName();
  const checks = useMemo(() => r.checks.filter((c) => c.expert === expert).sort((a, b) => rank(a.severity) - rank(b.severity)), [r, expert]);
  const review = r.ai[expert];
  const aiFindings = useMemo(() => [...(review?.findings ?? [])].sort((a, b) => rank(a.severity) - rank(b.severity)), [review]);
  const fixable = [...checks.filter((c) => c.severity !== 'info' && review?.verdicts[c.key]?.verdict !== 'dismissed').map(fromCheck), ...aiFindings.filter((f) => f.severity !== 'info').map(fromAi)];
  const serious = checks.filter((c) => rank(c.severity) <= 1).length + aiFindings.filter((f) => rank(f.severity) <= 1).length;
  return (
    <section className="rounded-[10px] ring-1 ring-inset ring-line" data-expert={expert}>
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-[13px] font-semibold text-fg">{label}</span>
        <span className="text-[12px] text-fg-3">
          {checks.length + aiFindings.length ? `${checks.length + aiFindings.length} found${serious ? `, ${serious} serious` : ''}` : 'Nothing found'}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant={review ? 'ghost' : 'secondary'} icon={thinking ? <Spinner /> : <Sparkles />} onClick={() => void experts.askAi(expert)} disabled={thinking} data-ask-ai={expert}>
          {review ? 'Again' : `Ask ${ai}`}
        </Button>
      </header>
      {review && (
        <p className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-fg-2" data-ai-summary>
          <Sparkles className="mr-1 inline size-3 text-ai" />
          {review.summary}
        </p>
      )}
      {checks.map((c: ReviewCheck) => (
        <Finding key={c.key} severity={c.severity} title={c.title} rule={c.rule} what={c.what} fix={c.fix} html={c.html} wcag={c.wcag} source={c.source} verdict={review?.verdicts[c.key]} item={fromCheck(c)} expert={expert} count={c.count} />
      ))}
      {aiFindings.map((f: AiFinding, i) => (
        <Finding key={`ai-${i}`} severity={f.severity} title={f.title} rule={f.rule} what={f.what} fix={f.fix} rewrite={f.rewrite} item={fromAi(f)} expert={expert} fromAi />
      ))}
      {fixable.length > 1 && (
        <div className="border-t border-line px-3 py-2">
          <Button size="sm" variant="ai" icon={<Wand2 />} onClick={() => void experts.fix(fixable, expert)} data-fix-expert={expert}>
            Fix all {fixable.length} with {ai}
          </Button>
        </div>
      )}
    </section>
  );
}

export function ExpertsTab() {
  const picked = useExperts((s) => s.picked);
  const review = useExperts((s) => s.review);
  const running = useExperts((s) => s.running);
  const progress = useExperts((s) => s.progress);
  const error = useExperts((s) => s.error);
  const appUrl = useStudio((s) => s.app.url);
  const connected = useStudio((s) => s.app.connected);
  const [installed, setInstalled] = useState<string[] | null>(null);

  // The saved review of the page shown, when the page changes.
  useEffect(() => {
    if (appUrl) void experts.load();
  }, [appUrl]);

  const shown = review && appUrl && sameRoute(review.url, appUrl) ? review : null;
  const counts = useMemo(() => {
    const c: Partial<Record<CheckSeverity, number>> = {};
    for (const x of shown?.checks ?? []) c[x.severity] = (c[x.severity] ?? 0) + 1;
    return c;
  }, [shown]);

  return (
    <div className="space-y-3 p-3" data-experts>
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-1.5">
          {EXPERT_LIST.map((e) => (
            <button
              key={e.id}
              title={e.hint}
              onClick={() => experts.toggle(e.id)}
              aria-pressed={picked.includes(e.id)}
              className={cn(
                'h-7 rounded-full px-3 text-[12px] font-medium ring-1 ring-inset transition-colors',
                picked.includes(e.id) ? 'bg-human-soft text-human-fg ring-human-line' : 'text-fg-3 ring-line hover:text-fg-2',
              )}
            >
              {e.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="md" onClick={() => void experts.run()} disabled={running || !picked.length || !connected} icon={running ? <Spinner /> : undefined} data-review-page>
            {running ? `Checking the page…${progress > 0 && progress < 1 ? ` ${Math.round(progress * 100)}%` : ''}` : shown ? 'Review again' : 'Review this page'}
          </Button>
          {shown && <span className="text-[11.5px] text-fg-3">{ago(shown.at)}</span>}
        </div>
        {!shown && !running && (
          <p className="text-[12px] leading-relaxed text-fg-3">
            Checks this page against Google Search Central, WCAG 2.2 (axe-core), GOV.UK and web.dev guidance, in your browser. Then an AI expert can judge what the checks can’t and every finding can be fixed in place.
          </p>
        )}
        {error && <p className="text-[12px] text-bad">{error}</p>}
      </div>

      {shown && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-3">
            <span className="min-w-0 truncate">{shortUrl(shown.url)}</span>
            {SEVERITY_ORDER.filter((s) => counts[s]).map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className={cn('size-[6px] rounded-full', SEV[s].dot)} />
                {counts[s]} {SEV[s].label.toLowerCase()}
              </span>
            ))}
          </div>
          <FieldCard r={shown} />
          {EXPERT_LIST.filter((e) => shown.experts.includes(e.id) || shown.ai[e.id]).map((e) => (
            <ExpertSection key={e.id} r={shown} expert={e.id} label={e.label} />
          ))}
          <div className="rounded-[10px] px-3 py-2.5 text-[12px] leading-relaxed text-fg-3 ring-1 ring-inset ring-line">
            Use the same experts in your own coding agent (Claude Code, Cursor, Codex, Copilot…): they are added to this app as Agent Skills.
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  const r = await experts.installSkills();
                  if (r) setInstalled(r.written);
                }}
              >
                Add to this app
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStudio({ overlay: 'settings', settingsTab: 'services' })}>
                Connect Google data
              </Button>
            </div>
            {installed && <div className="mt-1.5 font-mono text-[11px] text-ok">{installed.slice(0, 4).join(' · ')}</div>}
          </div>
        </>
      )}
    </div>
  );
}

/** The same page, whatever the studio's proxy did to its address. */
function sameRoute(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}
