import type { ReactElement, ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

export type BannerTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

const TONE_ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert, neutral: Info }

/** In-flow notice. Never floats; place it at the top of the region it talks about. */
export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  onDismiss,
  label,
  testId
}: {
  tone?: BannerTone
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
  /** Makes the banner a labelled region landmark. */
  label?: string
  testId?: string
}): ReactElement {
  return (
    <div
      className={`banner tone-${tone}`}
      role={label ? 'region' : tone === 'danger' ? 'alert' : 'status'}
      aria-label={label}
      data-testid={testId}
    >
      <span className="banner-icon">
        <Icon icon={TONE_ICON[tone]} size="md" />
      </span>
      <div className="banner-main">
        {title && <div className="banner-title">{title}</div>}
        {children && <div className="banner-body">{children}</div>}
        {actions && <div className="banner-actions">{actions}</div>}
      </div>
      {onDismiss && <IconButton icon={X} label="Dismiss notice" size="sm" onClick={onDismiss} />}
    </div>
  )
}
