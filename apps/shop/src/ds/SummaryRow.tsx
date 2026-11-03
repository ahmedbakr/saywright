import type { HTMLAttributes } from 'react';

export interface SummaryRowProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: string;
  size?: 'sm' | 'md' | 'lg';
  emphasis?: 'regular' | 'strong';
  tone?: 'default' | 'success' | 'danger';
}

export function SummaryRow({ label, value, size = 'md', emphasis = 'regular', tone = 'default', ...rest }: SummaryRowProps) {
  return (
    <div className="ds-row" data-size={size} data-emphasis={emphasis} data-tone={tone} {...rest}>
      <span>{label}</span>
      <span className="ds-row-value">{value}</span>
    </div>
  );
}
