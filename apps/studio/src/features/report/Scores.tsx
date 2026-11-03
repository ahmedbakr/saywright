import { ChevronDown, TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import type { ScoreBreakdown, SessionReport, SessionScores } from '@shared/session';
import { cn } from '@/lib/cn';
import type { Strings } from './i18n';

export function scoreTone(n: number): { color: string; soft: string; label: 'good' | 'fair' | 'poor' } {
  if (n >= 85) return { color: 'var(--ok)', soft: 'var(--ok-soft)', label: 'good' };
  if (n >= 65) return { color: 'var(--warn)', soft: 'var(--warn-soft)', label: 'fair' };
  return { color: 'var(--bad)', soft: 'var(--bad-soft)', label: 'poor' };
}

export function Ring({ value, size = 64, stroke = 6, children }: { value: number; size?: number; stroke?: number; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone = scoreTone(value);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--active)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone.color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(value / 100) * c} ${c}`}
          style={{ transition: 'stroke-dasharray 800ms var(--ease-snap)' }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children ?? <span className="tabular text-[15px] font-semibold text-fg">{value}</span>}</div>
    </div>
  );
}

function Delta({ now, before }: { now: number; before: number | undefined }) {
  if (before === undefined) return null;
  const d = now - before;
  if (!d) return <span className="text-[11px] text-fg-3">±0</span>;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium', d > 0 ? 'text-ok' : 'text-bad')}>
      {d > 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
      {d > 0 ? '+' : ''}
      {d}
    </span>
  );
}

const KEYS = ['stability', 'usability', 'performance', 'accessibility'] as const;

export function Scores({ scores, previous, report, t }: { scores: SessionScores; previous: SessionScores | null; report: SessionReport | null; t: Strings }) {
  const ar = report?.lang === 'ar';
  const [open, setOpen] = useState<(typeof KEYS)[number] | null>(null);
  return (
    <div className="grid gap-3 lg:grid-cols-[auto_1fr]">
      <div className="flex items-center gap-4 rounded-[14px] bg-raised p-4 ring-1 ring-inset ring-line">
        <Ring value={scores.overall} size={92} stroke={8}>
          <div className="text-center">
            <div className="tabular text-[26px] font-semibold leading-none tracking-[-0.03em] text-fg">{scores.overall}</div>
            <div className="mt-0.5 text-[10.5px] text-fg-3">/ 100</div>
          </div>
        </Ring>
        <div>
          <div className="text-[12px] font-medium text-fg-3">{t.overall}</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[15px] font-semibold capitalize" style={{ color: scoreTone(scores.overall).color }}>
              {t.tone[scoreTone(scores.overall).label]}
            </span>
            {previous && (
              <span className="flex items-center gap-1 text-[11px] text-fg-3">
                <Delta now={scores.overall} before={previous.overall} /> {t.vsPrevious}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {KEYS.map((k) => {
          const s: ScoreBreakdown = scores[k];
          const notes = (ar ? s.notesAr : null) ?? s.notes;
          const note = report?.scoreNotes?.[k] || notes[0] || '';
          const expanded = open === k;
          return (
            <button
              key={k}
              data-hand
              onClick={() => setOpen(expanded ? null : k)}
              className={cn('group flex flex-col rounded-[14px] bg-raised p-3 text-start ring-1 ring-inset ring-line transition-shadow hover:ring-line-strong', expanded && 'ring-line-strong')}
            >
              <div className="flex items-center gap-3">
                <Ring value={s.score} size={46} stroke={5} />
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-fg-2">{t[k]}</div>
                  <Delta now={s.score} before={previous?.[k].score} />
                </div>
                <ChevronDown className={cn('ms-auto size-3.5 text-fg-3 opacity-0 transition group-hover:opacity-100', expanded && 'rotate-180 opacity-100')} />
              </div>
              <p className={cn('mt-2 text-[11.5px] leading-snug text-fg-3', !expanded && 'line-clamp-2')}>{note}</p>
              {expanded && notes.length > 0 && notes[0].startsWith('−') && (
                <ul className="mt-2 space-y-1 border-t border-line pt-2">
                  {notes.map((n, i) => (
                    <li key={i} className="text-[11.5px] leading-snug text-fg-2">
                      <span className="tabular font-semibold text-bad">{n.split(':')[0]}</span>
                      {n.slice(n.indexOf(':'))}
                    </li>
                  ))}
                </ul>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
