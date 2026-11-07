import type { ReactElement, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { Icon } from './Icon'
import { IconButton } from './IconButton'
import { exitProps, useExitPresence } from '../../lib/useExitPresence'

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

/**
 * The one entry and exit recipe for a banner or notice (docs/design/motion.md 3.10). Wrap the conditional banner:
 *
 *   <BannerPresence show={!!notice}><Banner ... onDismiss={...}>{notice}</Banner></BannerPresence>
 *
 * - Arrival: when `show` turns true after the wrapper was mounted, the banner reveals its height and rises 4 px
 *   (`--dur-base`), so content below glides down instead of jumping. A banner shown at the first render never animates.
 *   The content is visible from the first frame, so a role=alert or status banner is still announced normally.
 * - Exit: when `show` turns false the last children stay for `--dur-fast`, inert and aria-hidden (`data-state='out'`),
 *   fading and folding shut. Use it for a user's Dismiss, Undo or a state they are watching; reduced motion removes the
 *   banner at once. Move focus in the same tick as the action, never after the exit.
 * - Renders nothing (no wrapper, no gap) while hidden and not leaving.
 */
export function BannerPresence({ show, children }: { show: boolean; children: ReactNode }): ReactElement | null {
  const exit = useExitPresence(show)
  const last = useRef<ReactNode>(null)
  if (show) last.current = children
  const wasHidden = useRef(!show)
  if (!show) wasHidden.current = true
  // `revealed`: the arrival animation has played for this showing (cleared when the banner goes away).
  const [revealed, setRevealed] = useState(false)
  if (!show && revealed) setRevealed(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // A leaving banner is inert: never leave focus on its Dismiss or Undo while it fades.
    if (show) return
    const a = document.activeElement
    if (a && a !== document.body && boxRef.current?.contains(a)) (a as HTMLElement).blur?.()
  }, [show])
  if (!show && !exit.mounted) return null
  const arrive = show && wasHidden.current && !revealed
  return (
    <div
      ref={boxRef}
      className="banner-presence leave-collapse"
      data-arrive={arrive ? 'true' : undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setRevealed(true)
      }}
      {...(show ? {} : exitProps(exit.state))}
    >
      {show ? children : last.current}
    </div>
  )
}
