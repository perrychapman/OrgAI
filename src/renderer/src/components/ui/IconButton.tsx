import type { ReactElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'

/** Icon-only button. `label` is required: it becomes the accessible name and the tooltip. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  size = 'md',
  expanded,
  controls,
  spin,
  testId,
  type = 'button'
}: {
  icon: LucideIcon
  label: string
  onClick?: () => void
  disabled?: boolean
  size?: 'sm' | 'md'
  /** Sets aria-expanded for disclosure toggles. */
  expanded?: boolean
  /** Ids (space separated) of what a disclosure toggle shows or hides: aria-controls. */
  controls?: string
  spin?: boolean
  testId?: string
  type?: 'button' | 'submit'
}): ReactElement {
  return (
    <button
      type={type}
      className={`icon-btn size-${size}${spin ? ' spin' : ''}`}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={controls}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon icon={icon} size="sm" />
    </button>
  )
}
