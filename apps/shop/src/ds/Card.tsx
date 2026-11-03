import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: string;
  padding?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'muted' | 'brand';
  children: ReactNode;
}

export function Card({ title, padding = 'md', tone = 'default', children, ...rest }: CardProps) {
  return (
    <section className="ds-card" data-padding={padding} data-tone={tone} {...rest}>
      {title && <h2 className="ds-card-title">{title}</h2>}
      {children}
    </section>
  );
}
