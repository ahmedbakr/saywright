import { Check, ChevronDown } from 'lucide-react';
import { Select as S } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  placeholder,
}: {
  value: T | undefined;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; note?: string }[];
  className?: string;
  placeholder?: string;
}) {
  return (
    <S.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <S.Trigger
        data-hand
        className={cn(
          'inline-flex h-8 min-w-[160px] items-center justify-between gap-2 rounded-[8px] bg-raised px-2.5 text-[12.5px] text-fg ring-1 ring-inset ring-line-strong hover:bg-hover',
          className,
        )}
      >
        <S.Value placeholder={placeholder} />
        <S.Icon>
          <ChevronDown className="size-3.5 text-fg-3" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="z-[80] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[10px] bg-raised p-1 shadow-pop">
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                data-hand
                className="relative flex cursor-default select-none items-center gap-2 rounded-[6px] py-1.5 pl-7 pr-3 text-[12.5px] text-fg outline-none data-[highlighted]:bg-hover"
              >
                <S.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5 text-human" />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
                {o.note && <span className="ml-auto pl-4 text-[11.5px] text-fg-3">{o.note}</span>}
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
