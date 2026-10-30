import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'
import markGlyph from '../../assets/brand/mark-glyph.svg'

/**
 * A screen or panel with no content. By default it shows the large brand glyph (the one hero moment per screen,
 * gradient at 14 percent opacity, 10 in light); pass `icon` for a small quiet lucide icon in nested panels.
 * Title is 20/600, the description is plain text, actions are Buttons.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  compact,
  testId
}: {
  /** A lucide icon instead of the brand glyph. Use in small panels where the hero glyph would shout. */
  icon?: LucideIcon
  title: string
  description?: ReactNode
  actions?: ReactNode
  compact?: boolean
  testId?: string
}): ReactElement {
  const glyphStyle = { '--glyph-url': `url(${JSON.stringify(markGlyph)})` } as CSSProperties
  return (
    <div className={compact ? 'empty-state compact' : 'empty-state'} data-testid={testId}>
      {icon ? (
        <span className="empty-state-icon">
          <Icon icon={icon} size="lg" />
        </span>
      ) : (
        <span className="empty-state-glyph" style={glyphStyle} aria-hidden="true" />
      )}
      <h2 className="empty-state-title">{title}</h2>
      {description && <p className="empty-state-desc">{description}</p>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  )
}
