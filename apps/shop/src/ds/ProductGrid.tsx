import type { HTMLAttributes, ReactNode } from 'react';

export interface ProductGridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: '2' | '3' | '4';
  gap?: 'sm' | 'md' | 'lg' | 'xl';
  children: ReactNode;
}

export function ProductGrid({ columns = '3', gap = 'md', children, ...rest }: ProductGridProps) {
  return (
    <div className="ds-grid" data-columns={columns} data-gap={gap} {...rest}>
      {children}
    </div>
  );
}
