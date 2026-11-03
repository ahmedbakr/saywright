import type { HTMLAttributes, ReactNode } from 'react';

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children: ReactNode;
}

export function Heading({ size = 'lg', children, ...rest }: HeadingProps) {
  return (
    <h1 className="ds-heading" data-size={size} {...rest}>
      {children}
    </h1>
  );
}
