/**
 * Replay & verify, in the report: after fixes, the session's steps were played
 * again in the app and compared with the session. What is fixed, what still
 * happens, what a replay can't tell, and anything new the replay ran into.
 */
import { ListRestart, ShieldCheck, TriangleAlert } from 'lucide-react';
import { replayReason, type ReportFinding, type SessionVerification } from '@shared/session';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { SEVERITY_STYLE, VERDICT_STYLE } from './Findings';
import type { ReportLang, Strings } from './i18n';

/** "2 minutes ago", in the report's language. */
function relTime(t: number, lang: ReportLang): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const s = Math.round((t - Date.now()) / 1000);
  if (Math.abs(s) < 45) return lang === 'ar' ? 'الآن' : 'just now';
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, 'minute');
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

export function Verification({
  verification: v,
  verifying,
  findings,
  t,
  lang,
  canReplay,
  onReplay,
}: {
  verification: SessionVerification | null;
  verifying: boolean;
  /** The findings counted (not set aside). */
  findings: ReportFinding[];
  t: Strings;
  lang: ReportLang;
  canReplay: boolean;
  onReplay: () => void;
}) {
  if (verifying)
    return (
      <section className="flex items-center gap-3 rounded-[14px] bg-raised px-4 py-3.5 ring-1 ring-inset ring-ai-line/40" data-verification="pending">
        <Spinner className="size-4 text-ai" />
        <span className="shimmer-text text-[13px] font-medium">{t.verifying}</span>
      </section>
    );
  if (!v) return null;
  const results = findings.map((f) => v.findings[f.id]).filter(Boolean);
  const n = { fixed: 0, still: 0, unknown: 0 };
  for (const r of results) n[r.verdict]++;
  const failed = v.steps.failed;
  return (
    <section className="rounded-[14px] bg-raised p-4 ring-1 ring-inset ring-line" data-verification="done">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          <ShieldCheck className="size-4 text-ai" />
          {t.verifyTitle}
        </h2>
        <span className="text-[11.5px] text-fg-3">{t.verifiedAgo(relTime(v.at, lang))}</span>
        <Button size="sm" variant="ghost" className="ms-auto" icon={<ListRestart />} onClick={onReplay} disabled={!canReplay} data-verify-again>
          {t.againBtn}
        </Button>
      </div>
      {results.length > 0 && (
        <>
          <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
            {(['fixed', 'still', 'unknown'] as const).map((k) => (n[k] ? <span key={k} className={cn('h-full', VERDICT_STYLE[k].bar)} style={{ width: `${(n[k] / results.length) * 100}%` }} /> : null))}
          </div>
          <p className="mt-2 text-[13px] font-medium text-fg" data-verify-summary>
            {t.verifySummary(n.fixed, n.still, n.unknown)}
          </p>
        </>
      )}
      <p className="mt-1 text-[12px] text-fg-3" data-verify-steps>
        {t.replayed(v.steps.done, v.steps.total)}
        {failed && (
          <>
            {' · '}
            <span className="text-warn">{t.stoppedAt(lang === 'ar' ? (failed.descriptionAr ?? failed.description) : failed.description, replayReason(failed.reason, lang))}</span>
          </>
        )}
      </p>
      {v.fresh.length > 0 && (
        <div className="mt-3 rounded-[10px] bg-warn-soft px-3 py-2" data-verify-fresh>
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-warn">
            <TriangleAlert className="size-3.5" />
            {t.fresh} ({v.fresh.length})
          </div>
          <ul className="space-y-1 text-[12.5px] text-fg-2">
            {v.fresh.slice(0, 8).map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className={cn('shrink-0 rounded-[4px] px-1 text-[10px] font-semibold uppercase', SEVERITY_STYLE[f.severity].chip)}>{t.severity[f.severity]}</span>
                <span className="min-w-0 truncate" dir="auto">
                  {lang === 'ar' ? (f.titleAr ?? f.title) : f.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
