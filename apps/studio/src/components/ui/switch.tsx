import { Switch as S } from 'radix-ui';
import { createContext, useContext } from 'react';
import { cn } from '@/lib/cn';

/** The id of the label of the row a switch sits in: the switch is named by it unless given its own name. */
export const SwitchLabel = createContext<string | undefined>(undefined);

export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
  'aria-label': label,
  'aria-labelledby': labelledBy,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  disabled?: boolean;
  /** Its name for screen readers, when no <label> names it. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const rowLabel = useContext(SwitchLabel);
  return (
    <S.Root
      id={id}
      aria-label={label}
      aria-labelledby={labelledBy ?? (label ? undefined : rowLabel)}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className={cn(
        'relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40',
        checked ? 'bg-human' : 'bg-active ring-1 ring-inset ring-line-strong',
      )}
    >
      <S.Thumb className="block size-[14px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.35)] transition-transform duration-200 will-change-transform data-[state=checked]:translate-x-[14px]" />
    </S.Root>
  );
}
