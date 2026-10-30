import type { InputHTMLAttributes, ReactElement } from 'react'

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'className' | 'size'> & {
  /** Receives the new text, not the event. */
  onChange: (value: string) => void
  /** Monospace for paths, ids and commands. */
  mono?: boolean
  /** Marks the field invalid (aria-invalid + danger border). Pair with a message referenced by aria-describedby. */
  invalid?: boolean
}

/** Single-line text field on the .input styles. Name it with a <label htmlFor={id}> or aria-label. */
export function Input({ onChange, mono, invalid, type = 'text', ...rest }: InputProps): ReactElement {
  return (
    <input
      {...rest}
      type={type}
      className={`input${mono ? ' mono' : ''}${invalid ? ' is-invalid' : ''}`}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
