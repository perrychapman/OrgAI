import type { ReactElement, ReactNode, Ref } from 'react'
import { useId } from 'react'

/**
 * One section of the Team Catalog (Skills, Connections or Plugins): a heading with a count, one section-level action
 * slot (the single "Add" button) and the content. `id` is the stable DOM id deep links use; `testId` is the
 * `catalog-*` id e2e uses. The header wraps under the title when the panel is narrow.
 */
export function CatalogGroup({
  id,
  title,
  count,
  description,
  actions,
  testId,
  sectionRef,
  children
}: {
  id: string
  title: string
  count?: number
  description?: ReactNode
  actions?: ReactNode
  testId: string
  sectionRef?: Ref<HTMLElement>
  children: ReactNode
}): ReactElement {
  const titleId = useId()
  return (
    <section id={id} ref={sectionRef} className="catalog-group" aria-labelledby={titleId} data-testid={testId}>
      <header className="catalog-group-head">
        <div className="catalog-group-heading">
          <h3 id={titleId} className="catalog-group-title">
            {title}
            {count !== undefined && <span className="muted"> {'·'} {count}</span>}
          </h3>
          {description && <p className="catalog-group-lead">{description}</p>}
        </div>
        {actions && <div className="catalog-group-actions">{actions}</div>}
      </header>
      {children}
    </section>
  )
}
