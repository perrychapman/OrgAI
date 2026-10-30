import type { ReactElement } from 'react'

/** On/off switch (role="switch"). `label` is the accessible name; Space toggles. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title,
  describedBy,
  testId
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  /** Id of the element that describes this switch (aria-describedby). */
  describedBy?: string
  testId?: string
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      title={title}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  )
}
