import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { useId } from 'react'

/**
 * One glass panel of the Home tab: a heading (h2) with an optional quiet note and one link on the right, then the body.
 * `enter` is the panel's place in the arrival order (a section that appears after its data loaded rises in; the first
 * paint and reduced motion do not animate). Both Home kinds use it; the kind's own look comes from `.code-home` and
 * `.eng-home` in styles/home.css.
 */
export function HomeSection({
  title,
  note,
  action,
  children,
  className,
  testId,
  enter,
  tone
}: {
  title: string
  note?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
  enter?: number
  tone?: 'waiting'
}): ReactElement {
  const id = useId()
  const cls = ['home-section', 'glass', enter !== undefined ? 'motion-enter' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <section className={cls} aria-labelledby={id} data-testid={testId} data-tone={tone} style={enter !== undefined ? ({ '--i': enter } as CSSProperties) : undefined}>
      <div className="home-section-head">
        <h2 id={id} className="home-section-title">
          {title}
        </h2>
        {note ? <span className="home-section-note">{note}</span> : null}
        {action}
      </div>
      {children}
    </section>
  )
}

/** A quiet text button that moves the user to another tab or page (the board's links). */
export function HomeLink({ children, onClick, testId, label }: { children: ReactNode; onClick: () => void; testId?: string; label?: string }): ReactElement {
  return (
    <button type="button" className="home-link" onClick={onClick} data-testid={testId} aria-label={label}>
      {children}
    </button>
  )
}
