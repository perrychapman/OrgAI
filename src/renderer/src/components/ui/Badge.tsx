import type { ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

/** Small status label. Always pair a tone with an icon or words; color is never the only signal. */
export function Badge({
  tone = 'neutral',
  icon,
  spin,
  title,
  children,
  testId
}: {
  tone?: BadgeTone
  icon?: LucideIcon
  /** Spin the icon (static under reduced motion). */
  spin?: boolean
  title?: string
  children: ReactNode
  testId?: string
}): ReactElement {
  return (
    <span className={`badge tone-${tone}`} title={title} data-testid={testId}>
      {icon && (
        <span className={spin ? 'badge-icon spin' : 'badge-icon'}>
          <Icon icon={icon} size="xs" />
        </span>
      )}
      {children}
    </span>
  )
}
