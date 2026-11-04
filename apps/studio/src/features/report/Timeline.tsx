import { AlertTriangle, Camera, Flag, Globe2, MessageSquareText, MousePointerClick, Navigation, Terminal, Timer, Wand2, Zap } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { TimelineItem } from '@shared/session';
import { VirtualList } from '@/components/ui/virtual-list';
import { cn } from '@/lib/cn';
import { fmtClock } from './Findings';
import type { ReportLang, Strings } from './i18n';

type Filter = 'all' | 'speech' | 'issues' | 'actions' | 'network';

const ICON: Record<TimelineItem['kind'], React.ReactNode> = {
  action: <MousePointerClick />,
  navigation: <Navigation />,
  speech: <MessageSquareText />,
  error: <AlertTriangle />,
  network: <Globe2 />,
  frustration: <Zap />,
  performance: <Timer />,
  mark: <Flag />,
  shot: <Camera />,
  command: <Wand2 />,
  console: <Terminal />,
};

const TONE: Partial<Record<TimelineItem['kind'], string>> = {
  speech: 'text-human-fg',
  error: 'text-bad',
  frustration: 'text-bad',
  network: 'text-warn',
  performance: 'text-warn',
  mark: 'text-ai-fg',
  console: 'text-warn',
};

export function Timeline({ items, omitted = 0, start, current, onPick, lang, t }: { items: TimelineItem[]; omitted?: number; start: number; current: number | null; onPick: (it: TimelineItem) => void; lang: ReportLang; t: Strings }) {
  // What was said stays in the words it was said in; the studio's own descriptions follow the report's language.
  const text = (x: TimelineItem) => (lang === 'ar' ? (x.textAr ?? x.text) : x.text);
  const detail = (x: TimelineItem) => (lang === 'ar' ? (x.detailAr ?? x.detail) : x.detail);
  const [filter, setFilter] = useState<Filter>('all');
  const list = useMemo(
    () =>
      items.filter((x) => {
        if (x.kind === 'shot') return false;
        if (filter === 'all') return true;
        if (filter === 'speech') return x.kind === 'speech' || x.kind === 'mark';
        if (filter === 'issues') return !!x.issue || x.kind === 'error' || x.kind === 'frustration';
        if (filter === 'network') return x.kind === 'network';
        return x.kind === 'action' || x.kind === 'navigation' || x.kind === 'command';
      }),
    [items, filter],
  );
  // The moment being shown, kept in view.
  const active = current == null ? null : list.reduce<TimelineItem | null>((best, x) => (x.t <= current + 300 ? x : best), null);

  const counts = {
    speech: items.filter((x) => x.kind === 'speech').length,
    issues: items.filter((x) => x.issue).length,
  };
  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: t.chips.all },
    { id: 'speech', label: `${t.chips.speech} ${counts.speech}` },
    { id: 'issues', label: `${t.chips.issues} ${counts.issues}` },
    { id: 'actions', label: t.chips.actions },
    { id: 'network', label: t.chips.network },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        {chips.map((c) => (
          <button
            key={c.id}
            onClick={() => setFilter(c.id)}
            className={cn('h-6 rounded-full px-2.5 text-[11.5px] font-medium ring-1 ring-inset ring-line', filter === c.id ? 'bg-fg text-inverse ring-fg' : 'text-fg-2 hover:bg-hover')}
          >
            {c.label}
          </button>
        ))}
      </div>
      {omitted > 0 && <p className="px-3.5 pb-2 text-[11px] text-fg-3">{t.momentsNotListed(omitted)}</p>}
      <VirtualList
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
        items={list}
        keyOf={(x) => x.id}
        estimate={(x) => (x.kind === 'speech' ? 56 : x.src ? 48 : 32)}
        reveal={active?.id ?? null}
        render={(x) => <Row x={x} start={start} active={active?.id === x.id} text={x.kind === 'speech' ? `“${x.text}”` : text(x)} detail={x.kind === 'speech' && x.detail ? detail(x) : undefined} onPick={onPick} />}
        empty={<p className="px-3 py-6 text-center text-[12px] text-fg-3">{t.nothingHere}</p>}
      />
    </div>
  );
}

/** One moment. Memoised: playing the recording moves the highlight many times a second, and only two rows change. */
const Row = memo(function Row({ x, start, active, text, detail, onPick }: { x: TimelineItem; start: number; active: boolean; text: string; detail?: string; onPick: (it: TimelineItem) => void }) {
  return (
    <button
      data-tl={x.id}
      onClick={() => onPick(x)}
      className={cn('flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-start transition-colors hover:bg-hover', active && 'bg-active', x.kind === 'speech' && 'py-2')}
    >
      <span className="tabular w-9 shrink-0 pt-px text-[11px] text-fg-3">{fmtClock(x.t - start)}</span>
      <span className={cn('pt-[3px] text-fg-3 [&_svg]:size-[13px]', TONE[x.kind])}>{ICON[x.kind]}</span>
      <span className="min-w-0 flex-1">
        <span dir={x.kind === 'speech' ? 'auto' : undefined} className={cn('block text-[12.5px] leading-snug', x.kind === 'speech' ? 'font-medium text-fg' : 'text-fg-2', (x.kind === 'error' || x.kind === 'frustration') && 'text-bad')}>
          {text}
        </span>
        {detail || x.src ? (
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-3">
            {detail && <span>{detail}</span>}
            {x.src && (
              <span className="truncate font-mono" dir="ltr">
                {x.src}
              </span>
            )}
          </span>
        ) : null}
      </span>
      {x.issue && <span className="mt-0.5 shrink-0 rounded-[4px] bg-bad-soft px-1 text-[10px] font-semibold text-bad">{x.issue}</span>}
    </button>
  );
});
