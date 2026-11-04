/** The raw facts behind the report: errors, requests, speed and pages (what was said is in the transcript beside it). */
import { Tabs } from 'radix-ui';
import { useState } from 'react';
import type { SessionAnalysis } from '@shared/session';
import { cn } from '@/lib/cn';
import { ms } from '@/lib/format';
import { fmtClock } from './Findings';
import type { ReportLang, Strings } from './i18n';

function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className="relative h-8 px-1 text-[12.5px] font-medium text-fg-3 transition-colors hover:text-fg-2 data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:bg-fg"
    >
      {children}
    </Tabs.Trigger>
  );
}

/** Rows shown at first, and added by each “Show more”: a long session can have hundreds. */
const PAGE = 50;

/** The first rows of a long list, and a button for the next ones. */
function useShown<T>(items: T[], t: Strings): { shown: T[]; more: React.ReactNode } {
  const [count, setCount] = useState(PAGE);
  const rest = items.length - count;
  const more =
    rest > 0 ? (
      <button onClick={() => setCount(count + PAGE)} className="block w-full rounded-[8px] px-2.5 py-2 text-center text-[12px] font-medium text-fg-2 hover:bg-hover" data-show-more>
        {t.showMore(Math.min(PAGE, rest))}
      </button>
    ) : null;
  return { shown: items.slice(0, count), more };
}

export function Details({ analysis: a, start, onPick, lang, t }: { analysis: SessionAnalysis; start: number; onPick: (t: number) => void; lang: ReportLang; t: Strings }) {
  const errors = a.issues.filter((g) => g.kind === 'error' || g.kind === 'console');
  const errorRows = useShown(errors, t);
  const pageRows = useShown(a.pages, t);
  const unlisted = (a.more?.issues.error ?? 0) + (a.more?.issues.console ?? 0);
  return (
    <section className="rounded-[14px] bg-raised ring-1 ring-inset ring-line">
      <Tabs.Root defaultValue="errors">
        <Tabs.List className="flex gap-5 border-b border-line px-4">
          <Tab value="errors">
            {t.tabs.errors} ({errors.length})
          </Tab>
          <Tab value="network">
            {t.tabs.network} ({a.network.total})
          </Tab>
          <Tab value="perf">{t.tabs.speed}</Tab>
          <Tab value="pages">
            {t.tabs.pages} ({a.pages.length})
          </Tab>
        </Tabs.List>
        <Tabs.Content value="errors" className="max-h-[420px] space-y-2 overflow-y-auto p-3 outline-none">
          {!errors.length && <p className="p-4 text-center text-[12.5px] text-fg-3">{t.noErrors}</p>}
          {errorRows.shown.map((g) => (
            <button key={g.id} onClick={() => onPick(g.t)} className="block w-full rounded-[10px] bg-sunken p-3 text-start ring-1 ring-inset ring-line hover:ring-line-strong">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-bad">
                {lang === 'ar' ? (g.titleAr ?? g.title) : g.title}
                {g.count > 1 && <span className="rounded-[4px] bg-bad-soft px-1 text-[10.5px]">×{g.count}</span>}
              </div>
              {g.src && <div className="mt-1 font-mono text-[11px] text-fg-2">{g.src}</div>}
              {g.detail && (
                <pre className="mt-2 max-h-28 overflow-hidden whitespace-pre-wrap text-[11px] leading-relaxed text-fg-3" dir="ltr">
                  {g.detail}
                </pre>
              )}
            </button>
          ))}
          {errorRows.more}
          {unlisted > 0 && <p className="px-2 py-1 text-center text-[11.5px] text-fg-3">{t.notListed(unlisted)}</p>}
        </Tabs.Content>
        <Tabs.Content value="network" className="max-h-[420px] overflow-y-auto p-2 outline-none">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-start text-[11px] text-fg-3">
                <th className="px-2 py-1.5 text-start font-medium">{t.cols.request}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t.cols.calls}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t.cols.avg}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t.cols.status}</th>
              </tr>
            </thead>
            <tbody>
              {a.network.endpoints.map((e) => (
                <tr key={`${e.method} ${e.url}`} className="border-t border-line">
                  <td className="max-w-[340px] truncate px-2 py-1.5 font-mono text-[11.5px] text-fg" dir="ltr">
                    <span className="text-fg-3">{e.method}</span> {e.url}
                  </td>
                  <td className="tabular px-2 py-1.5 text-fg-2">{e.count}</td>
                  <td className={cn('tabular px-2 py-1.5', e.avgMs > 1500 ? 'text-warn' : 'text-fg-2')}>{ms(e.avgMs)}</td>
                  <td className="px-2 py-1.5">
                    {e.statuses.map((s) => (
                      <span key={s} className={cn('me-1 rounded-[4px] px-1 font-mono text-[10.5px]', s === 0 || s >= 400 ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok')}>
                        {s || 'ERR'}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!a.network.endpoints.length && <p className="p-4 text-center text-[12.5px] text-fg-3">{t.noRequests}</p>}
        </Tabs.Content>
        <Tabs.Content value="perf" className="grid grid-cols-2 gap-2 p-3 outline-none md:grid-cols-3">
          {[
            [lang === 'ar' ? 'أول رسم' : 'First paint', ms(a.perf.fcp), a.perf.fcp != null && a.perf.fcp > 1800],
            [lang === 'ar' ? 'المحتوى الرئيسي' : 'Main content', ms(a.perf.lcp), a.perf.lcp != null && a.perf.lcp > 2500],
            [lang === 'ar' ? 'إزاحة التخطيط' : 'Layout shift', a.perf.cls.toFixed(3), a.perf.cls > 0.1],
            [lang === 'ar' ? 'أبطأ تفاعل' : 'Slowest interaction', ms(a.perf.slowestInteraction), (a.perf.slowestInteraction ?? 0) > 200],
            [lang === 'ar' ? 'عمل التطبيق الطويل' : 'App busy (long tasks)', `${a.perf.longTasks} · ${ms(a.perf.longTaskMs)}`, a.perf.longTaskMs > 2000],
            [lang === 'ar' ? 'طلبات بطيئة' : 'Slow requests', String(a.network.slow), a.network.slow > 0],
          ].map(([label, value, bad]) => (
            <div key={String(label)} className="rounded-[10px] bg-sunken p-3 ring-1 ring-inset ring-line">
              <div className="text-[11.5px] text-fg-3">{label}</div>
              <div className={cn('tabular mt-1 text-[17px] font-semibold', bad ? 'text-warn' : 'text-fg')}>{value}</div>
            </div>
          ))}
        </Tabs.Content>
        <Tabs.Content value="pages" className="max-h-[420px] overflow-y-auto p-2 outline-none">
          {pageRows.shown.map((p, i) => (
            <button key={i} onClick={() => onPick(p.t)} className="flex w-full items-center gap-3 rounded-[8px] px-2.5 py-2 text-start hover:bg-hover">
              <span className="tabular w-10 text-[11.5px] text-fg-3">{fmtClock(p.t - start)}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{p.title || p.url}</span>
              <span className="truncate font-mono text-[11px] text-fg-3" dir="ltr">
                {p.url}
              </span>
              <span className="tabular text-[11.5px] text-fg-2">{ms(p.ms)}</span>
            </button>
          ))}
          {pageRows.more}
        </Tabs.Content>
      </Tabs.Root>
      {(!!a.summarised || !!a.dropped) && (
        <p className="border-t border-line px-4 py-2 text-[11.5px] text-fg-3">{[a.summarised ? t.summarised(a.summarised) : '', a.dropped ? t.dropped(a.dropped) : ''].filter(Boolean).join(' ')}</p>
      )}
    </section>
  );
}
