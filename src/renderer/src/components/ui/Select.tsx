import type { ReactElement } from 'react'

/** Native single choice on the .select styles. Name it with a <label htmlFor={id}> or aria-label. */
export function Select({
  id,
  value,
  options,
  onChange,
  label,
  disabled,
  describedBy
}: {
  id?: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  /** Accessible name when there is no <label htmlFor>. */
  label?: string
  disabled?: boolean
  /** Id of the element that describes this control (aria-describedby). */
  describedBy?: string
}): ReactElement {
  return (
    <select id={id} className="select" value={value} aria-label={label} aria-describedby={describedBy} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
