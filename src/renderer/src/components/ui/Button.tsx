import type { ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { LoaderCircle } from 'lucide-react'
import { Icon } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** Text button on the .btn styles. `loading` keeps the label, shows a spinner and sets aria-busy. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  disabled,
  onClick,
  children,
  title,
  testId,
  type = 'button',
  autoFocusDialog
}: {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: LucideIcon
  loading?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  title?: string
  testId?: string
  type?: 'button' | 'submit'
  /** Dialog focuses this control when it opens. */
  autoFocusDialog?: boolean
}): ReactElement {
  const cls = ['btn', variant === 'secondary' ? '' : variant, size === 'sm' ? 'sm' : ''].filter(Boolean).join(' ')
  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={title}
      onClick={onClick}
      data-testid={testId}
      data-autofocus={autoFocusDialog ? '' : undefined}
    >
      {loading ? (
        <span className="spin">
          <Icon icon={LoaderCircle} size="sm" />
        </span>
      ) : (
        icon && <Icon icon={icon} size="sm" />
      )}
      {children}
    </button>
  )
}
