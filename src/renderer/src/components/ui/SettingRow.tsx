import type { ReactElement, ReactNode } from 'react'

export type SettingRowWidth = 'number' | 'select' | 'full'

/**
 * Title and one-line description on the left, the control on the right (wraps under the text in a narrow column).
 * `width` fixes the control column: number (about 120px), select (about 240px, also segmented controls) or full
 * (the control takes its own line, for paths and textareas). `hint` sits under the control; `more` is long rationale
 * behind a native "Learn more" disclosure under the description.
 */
export function SettingRow({
  title,
  description,
  control,
  id,
  width,
  hint,
  more
}: {
  title: string
  description?: ReactNode
  control: ReactNode
  id?: string
  width?: SettingRowWidth
  hint?: ReactNode
  more?: ReactNode
}): ReactElement {
  return (
    <div className={`setting-row${width ? ` w-${width}` : ''}`}>
      <div className="setting-row-text">
        <span className="setting-row-title" id={id}>
          {title}
        </span>
        {description && <span className="setting-row-desc">{description}</span>}
        {more && (
          <details className="setting-row-more">
            <summary>Learn more</summary>
            <div className="setting-row-more-body">{more}</div>
          </details>
        )}
      </div>
      <div className="setting-row-side">
        <div className="setting-row-control">{control}</div>
        {hint && <span className="setting-row-hint">{hint}</span>}
      </div>
    </div>
  )
}
