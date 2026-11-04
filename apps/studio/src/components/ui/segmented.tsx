import { motion } from 'motion/react';
import { ToggleGroup } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Tip } from './tooltip';

interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  title?: string;
  /** A tooltip (on hover and on focus), with its key. */
  tip?: string;
  kbd?: string;
}

/** A segmented control with a sliding indicator. `collapse`: below 1180 px wide only the icons show. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  collapse = false,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  size?: 'sm' | 'md';
  collapse?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      className={cn('relative inline-flex items-center gap-0.5 rounded-[9px] bg-sunken p-[3px] ring-1 ring-inset ring-line', className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        const item = (
          <ToggleGroup.Item
            key={o.value}
            value={o.value}
            title={o.tip ? undefined : o.title}
            className={cn(
              'relative inline-flex select-none items-center justify-center gap-1.5 rounded-[6px] font-medium transition-colors duration-150 [&_svg]:size-[13px]',
              size === 'md' ? 'h-[26px] px-2.5 text-[12.5px]' : 'h-[22px] px-2 text-[11.5px]',
              collapse && o.icon && 'max-[1179px]:px-2',
              on ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-[6px] bg-raised shadow-[0_0_0_1px_var(--line-strong),0_1px_2px_rgba(0,0,0,.18)]"
                transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.7 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {o.icon}
              <span className={cn(collapse && o.icon && 'max-[1179px]:sr-only')}>{o.label}</span>
            </span>
          </ToggleGroup.Item>
        );
        // The tooltip goes on a wrapper: on the item itself it would take over the item's data-state.
        return o.tip ? (
          <Tip key={o.value} label={o.tip} kbd={o.kbd}>
            <span className="inline-flex">{item}</span>
          </Tip>
        ) : (
          item
        );
      })}
    </ToggleGroup.Root>
  );
}
