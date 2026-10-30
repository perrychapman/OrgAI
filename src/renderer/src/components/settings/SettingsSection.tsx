import type { ReactElement, ReactNode, Ref } from 'react'
import { useId } from 'react'

/**
 * One settings section, the same on both pages: a title (one tier above row labels), an optional one-line lead, an
 * optional actions slot (buttons that act on the whole section) and then its content (usually `SettingsCard`s).
 * `id` is the stable DOM id deep links and e2e use.
 */
export function SettingsSection({
  id,
  title,
  description,
  actions,
  testId,
  sectionRef,
  children
}: {
  id: string
  title: string
  /** One line under the title. */
  description?: ReactNode
  /** Section-level buttons, right of the title (wraps below it when narrow). */
  actions?: ReactNode
  testId?: string
  sectionRef?: Ref<HTMLElement>
  children: ReactNode
}): ReactElement {
  const titleId = useId()
  return (
    <section id={id} ref={sectionRef} className="settings-section" aria-labelledby={titleId} data-testid={testId}>
      <header className="settings-section-head">
        <div className="settings-section-heading">
          <h2 id={titleId} className="settings-section-title">
            {title}
          </h2>
          {description && <p className="settings-section-lead">{description}</p>}
        </div>
        {actions && <div className="settings-section-actions">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

/** Lower-tier heading (caption, sentence case) above a card or a run of rows inside a section. */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }): ReactElement {
  const titleId = useId()
  return (
    <div className="settings-group" role="group" aria-labelledby={titleId}>
      <h3 id={titleId} className="settings-group-title">
        {title}
      </h3>
      {children}
    </div>
  )
}
