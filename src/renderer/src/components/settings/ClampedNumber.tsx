import type { ReactElement } from 'react'
import { useState } from 'react'
import { Input } from '../ui/Input'

/**
 * Whole-number field that lets the user clear it while typing; commits valid values clamped to min..max and restores
 * on blur. Used by the project Limits pane and the App settings defaults so both clamp the same way.
 */
export function ClampedNumber({
  id,
  label,
  value,
  min,
  max,
  disabled,
  describedBy,
  onCommit
}: {
  id?: string
  label: string
  value: number
  min: number
  max: number
  disabled?: boolean
  describedBy?: string
  onCommit: (n: number) => void
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(v) => {
        setDraft(v)
        const n = Number(v)
        if (v !== '' && Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, Math.floor(n))))
      }}
      onBlur={() => setDraft(null)}
    />
  )
}
