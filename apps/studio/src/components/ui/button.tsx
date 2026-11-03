import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'human' | 'ai' | 'danger' | 'ok';
type Size = 'xs' | 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary: 'bg-fg text-inverse hover:bg-fg/90 shadow-[inset_0_1px_0_rgba(255,255,255,.12)]',
  secondary: 'bg-raised text-fg ring-1 ring-inset ring-line-strong hover:bg-hover hover:ring-line-strong',
  ghost: 'text-fg-2 hover:text-fg hover:bg-hover',
  human: 'bg-human text-[#1b1203] hover:brightness-105',
  ai: 'bg-ai-soft text-ai-fg ring-1 ring-inset ring-ai-line/40 hover:bg-ai-soft/80',
  danger: 'text-bad hover:bg-bad-soft',
  ok: 'bg-ok text-inverse hover:brightness-105',
};

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-[6px]',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-[7px]',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-[8px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  kbd?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'sm', icon, kbd, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      data-hand
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,box-shadow,filter] duration-150 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-[14px] [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {kbd}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: 'sm' | 'md' }>(function IconButton(
  { className, active, size = 'md', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      data-hand
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-[7px] text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[15px]',
        size === 'md' ? 'size-8' : 'size-7 [&_svg]:size-[14px]',
        active && 'bg-active text-fg',
        className,
      )}
      {...rest}
    />
  );
});
