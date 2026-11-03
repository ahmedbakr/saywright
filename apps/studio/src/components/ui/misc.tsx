import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'human' | 'ai' | 'ok' | 'bad' | 'warn';

const tones: Record<Tone, string> = {
  neutral: 'bg-active text-fg-2',
  human: 'bg-human-soft text-human-fg',
  ai: 'bg-ai-soft text-ai-fg',
  ok: 'bg-ok-soft text-ok',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-[18px] items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-medium leading-none', tones[tone], className)}>{children}</span>;
}

export function Dot({ tone = 'neutral', pulse, className }: { tone?: Tone | 'off'; pulse?: boolean; className?: string }) {
  const color = {
    neutral: 'bg-fg-3',
    off: 'bg-fg-3/60',
    human: 'bg-human',
    ai: 'bg-ai',
    ok: 'bg-ok',
    bad: 'bg-bad',
    warn: 'bg-warn',
  }[tone];
  return (
    <span className={cn('relative inline-flex size-[7px] shrink-0', className)}>
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', color)} />}
      <span className={cn('relative inline-flex size-[7px] rounded-full', color)} />
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn('size-[14px] animate-[spin_0.8s_linear_infinite]', className)} fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity=".2" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between">
      <h2 className="shrink-0 whitespace-nowrap text-[12px] font-medium text-fg-3">{children}</h2>
      {action}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-[10px] bg-sunken text-fg-3 ring-1 ring-inset ring-line [&_svg]:size-[18px]">{icon}</div>
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {children && <div className="mt-1 max-w-[260px] text-[12.5px] leading-relaxed text-fg-3">{children}</div>}
    </div>
  );
}
