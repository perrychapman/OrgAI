import type { ReactElement } from 'react'
import { useId } from 'react'

/** Exclusive choice as a native radio group (arrow keys move, Tab enters the group). */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  /** Accessible name of the group. */
  label: string
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
}): ReactElement {
  const name = useId()
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={`seg-item ${value === o.value ? 'on' : ''}`} title={o.title}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  )
}
