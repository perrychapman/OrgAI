import type { ReactElement } from 'react'

/** On/off switch (role="switch"). `label` is the accessible name; Space toggles. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  )
}
