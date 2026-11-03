import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { Kbd } from './kbd';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </T.Provider>
  );
}

export function Tip({ label, kbd, side = 'bottom', children }: { label: ReactNode; kbd?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[70] flex items-center gap-2 rounded-[7px] bg-raised px-2 py-1 text-[12px] text-fg shadow-pop"
        >
          {label}
          {kbd && <Kbd>{kbd}</Kbd>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
