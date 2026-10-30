import type { ReactElement, ReactNode } from 'react'
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
  onExpand
}: {
  collapsed?: boolean
  /** Rendered after the wordmark, e.g. `<Badge testId="mock-mode-badge">MOCK</Badge>`. Hidden when collapsed. */
  tag?: ReactNode
  /** Rendered at the trailing edge, e.g. the sidebar collapse IconButton. Hidden when collapsed. */
  trailing?: ReactNode
  /** Collapsed only: click the mark to expand the sidebar. */
  onExpand?: () => void
}): ReactElement {
  const img = <img className="brand-lockup-mark" src={mark} alt="" width={collapsed ? 28 : 32} height={collapsed ? 28 : 32} />
  if (collapsed) {
    return (
      <div className="brand-lockup collapsed">
        {onExpand ? (
          <button type="button" className="brand-lockup-expand" aria-label="Expand sidebar" title="Expand sidebar" onClick={onExpand}>
            {img}
          </button>
        ) : (
          <span role="img" aria-label="OrgAI">
            {img}
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
