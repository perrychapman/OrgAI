import type { ReactElement, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Icon } from '../ui/Icon'
import mark from '../../assets/brand/mark.svg'

/**
 * The brand row: 32 px mark, "OrgAI" as live text (16/600, never accent-coloured), an optional tag slot
 * (the neutral MOCK badge) and a trailing slot (the collapse button). Clear space is 0.5x the mark.
 * Collapsed shows the mark alone at 28 px; with `onExpand` the mark becomes the expand button.
 */
export function BrandLockup({
  collapsed,
  tag,
  trailing,
  onExpand,
  railNote
}: {
  collapsed?: boolean
  /** Rendered after the wordmark, e.g. `<Badge testId="mock-mode-badge">MOCK</Badge>`. Hidden when collapsed. */
  tag?: ReactNode
  /** Rendered at the trailing edge, e.g. the sidebar collapse IconButton. Hidden when collapsed. */
  trailing?: ReactNode
  /** Collapsed only: click the mark to expand the sidebar. */
  onExpand?: () => void
  /** Collapsed only: a short note ("Mock mode: ...") shown as a dot on the mark with a tooltip, since the tag is hidden. */
  railNote?: string
}): ReactElement {
  const img = <img className="brand-lockup-mark" src={mark} alt="" width={collapsed ? 28 : 32} height={collapsed ? 28 : 32} />
  if (collapsed) {
    const dot = railNote ? <span className="brand-lockup-dot" aria-hidden="true" /> : null
    const label = railNote ? `Expand sidebar. ${railNote}` : 'Expand sidebar'
    return (
      <div className="brand-lockup collapsed">
        {onExpand ? (
          <button type="button" className="brand-lockup-expand" aria-label={label} title={railNote ? `Expand sidebar. ${railNote}` : 'Expand sidebar'} onClick={onExpand}>
            {img}
            {dot}
            <Icon icon={ChevronRight} size="xs" />
          </button>
        ) : (
          <span role="img" aria-label={railNote ? `OrgAI. ${railNote}` : 'OrgAI'} title={railNote}>
            {img}
            {dot}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="brand-lockup">
      {img}
      <span className="brand-lockup-word">OrgAI</span>
      {tag}
      {trailing && <span className="brand-lockup-trail">{trailing}</span>}
    </div>
  )
}
