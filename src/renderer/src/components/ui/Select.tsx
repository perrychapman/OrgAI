import type { ReactElement } from 'react'

/** Native single choice on the .select styles. Name it with a <label htmlFor={id}> or aria-label. */
export function Select({
  id,
  value,
  options,
  onChange,
  label,
  disabled
}: {
  id?: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  /** Accessible name when there is no <label htmlFor>. */
  label?: string
  disabled?: boolean
}): ReactElement {
  return (
    <select id={id} className="select" value={value} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
