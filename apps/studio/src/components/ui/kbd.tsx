import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Kbd({ children, className, tone = 'default' }: { children: ReactNode; className?: string; tone?: 'default' | 'onDark' }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] px-1 font-mono text-[10.5px] font-medium leading-none',
        tone === 'default' ? 'bg-sunken text-fg-2 ring-1 ring-inset ring-line shadow-[inset_0_-1px_0_var(--line)]' : 'bg-white/15 text-current',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
