import type { HTMLAttributes, ReactNode } from 'react';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'success' | 'danger' | 'brand';
  children: ReactNode;
}

export function Badge({ tone = 'neutral', children, ...rest }: BadgeProps) {
  return (
    <span className="ds-badge" data-tone={tone} {...rest}>
      {children}
    </span>
  );
}
