import type { ReactElement, ReactNode } from 'react'
import { useId } from 'react'

/** One project-settings section: the same sentence-case heading, optional lead line, then its controls. */
export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }): ReactElement {
  const titleId = useId()
  return (
    <section id={id} className="settings-block" aria-labelledby={titleId}>
      <h2 id={titleId} className="side-section-title">
        {title}
      </h2>
      {description && <p className="settings-block-lead">{description}</p>}
      {children}
    </section>
  )
}

/** Smaller heading for a group of related controls inside a section. */
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
