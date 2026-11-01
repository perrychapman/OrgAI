import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { START_PAGE_COPY } from '../../lib/assistants'
import { EmptyState } from '../ui/EmptyState'

/** The Chat start page (stub; the form with folder, team, edits and the composer lands next). */
export default function ChatStartPage({ project: _project }: { project: Project }): ReactElement {
  const copy = START_PAGE_COPY.quick
  return (
    <div className="new-run" data-testid="assistant-start-quick">
      <div className="new-run-inner">
        <EmptyState title={copy.title} description={copy.description} />
      </div>
    </div>
  )
}
