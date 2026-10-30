import type { ReactElement, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Icon } from './Icon'

/**
 * Checkbox on a native <input type="checkbox"> (Space toggles, form semantics, visible :focus-visible ring).
 * Use for choices; use Switch for settings that take effect immediately. Replaces the label.check pill.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  title,
  testId
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  /** Secondary line under the label. */
  description?: ReactNode
  disabled?: boolean
  title?: string
  testId?: string
}): ReactElement {
  return (
    <label className={`checkbox${disabled ? ' is-disabled' : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden="true">
        <Icon icon={Check} size="sm" />
      </span>
      <span className="checkbox-text">
        <span className="checkbox-label">{label}</span>
        {description && <span className="checkbox-desc">{description}</span>}
      </span>
    </label>
  )
}
