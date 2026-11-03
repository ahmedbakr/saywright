import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'link' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', fullWidth = false, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button className="ds-button" data-variant={variant} data-size={size} data-full={fullWidth} type={type} {...rest}>
      {children}
    </button>
  );
}
