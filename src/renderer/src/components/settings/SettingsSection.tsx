import type { ReactElement, ReactNode, Ref } from 'react'
import { createContext, useContext, useId } from 'react'

/** The active pane's label, provided by `SettingsPage`. A section titled the same as its pane hides its (h3) title visually. */
export const PaneTitleContext = createContext<string | null>(null)

/**
 * One settings section, the same on both pages: a title (h3, under the pane's h2; one tier above row labels), an
 * optional one-line lead, an optional actions slot (buttons that act on the whole section) and then its content
 * (usually `SettingsCard`s). `id` is the stable DOM id deep links and e2e use; `titleId` pins the heading's id
 * (default: generated). When the title repeats the pane heading it stays in the accessibility tree but is hidden.
 */
export function SettingsSection({
  id,
  title,
  titleId: pinnedTitleId,
  description,
  actions,
  testId,
  sectionRef,
  children
}: {
  id: string
  title: string
  titleId?: string
  /** One line under the title. */
  description?: ReactNode
  /** Section-level buttons, right of the title (wraps below it when narrow). */
  actions?: ReactNode
  testId?: string
  sectionRef?: Ref<HTMLElement>
  children: ReactNode
}): ReactElement {
  const generated = useId()
  const titleId = pinnedTitleId ?? generated
  const paneTitle = useContext(PaneTitleContext)
  const repeats = paneTitle !== null && paneTitle.toLowerCase() === title.toLowerCase()
  return (
    <section id={id} ref={sectionRef} className="settings-section" aria-labelledby={titleId} data-testid={testId}>
      <header className="settings-section-head">
        <div className="settings-section-heading">
          <h3 id={titleId} className={`settings-section-title${repeats ? ' sr-only' : ''}`}>
            {title}
          </h3>
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
      <h4 id={titleId} className="settings-group-title">
        {title}
      </h4>
      {children}
    </div>
  )
}
