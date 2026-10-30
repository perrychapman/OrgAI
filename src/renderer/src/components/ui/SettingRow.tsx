import type { ReactElement, ReactNode } from 'react'

/** Title and one-line description on the left, the control on the right. Wraps under a container-narrow column. */
export function SettingRow({ title, description, control, id }: { title: string; description?: ReactNode; control: ReactNode; id?: string }): ReactElement {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-title" id={id}>
          {title}
        </span>
        {description && <span className="setting-row-desc">{description}</span>}
      </div>
      <div className="setting-row-control">{control}</div>
    </div>
  )
}
