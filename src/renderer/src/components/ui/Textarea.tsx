import type { ReactElement, TextareaHTMLAttributes } from 'react'

export type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'className'> & {
  /** Receives the new text, not the event. */
  onChange: (value: string) => void
  mono?: boolean
  invalid?: boolean
}

/** Multi-line text field on the .textarea styles. Name it with a <label htmlFor={id}> or aria-label. */
export function Textarea({ onChange, mono, invalid, rows = 3, ...rest }: TextareaProps): ReactElement {
  return (
    <textarea
      {...rest}
      rows={rows}
      className={`textarea${mono ? ' mono' : ''}${invalid ? ' is-invalid' : ''}`}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
