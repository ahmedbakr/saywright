import { useId, type InputHTMLAttributes } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
}

export function TextField({ label, value, onChange, hint, error, ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <div className="ds-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="ds-input"
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {(error || hint) && (
        <span className="ds-field-hint" data-tone={error ? 'danger' : undefined}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}
