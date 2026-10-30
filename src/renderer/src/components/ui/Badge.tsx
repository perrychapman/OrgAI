import type { ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'

/**
 * One shape, three tones (docs/design/ui-review-2.md C.5): `neutral` (kind labels, counts, MOCK), `accent`
 * (selected or "yours") and status. The status tones are `success`, `attention` (the warning hue, "needs you"),
 * `info` and `danger`. `warning` stays as an alias of `attention` so existing call sites keep working.
 */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'attention' | 'info' | 'warning' | 'danger'

/** Small label, 20 px, soft fill, no border. Always pair a status tone with an icon or words; color is never the only signal. */
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
