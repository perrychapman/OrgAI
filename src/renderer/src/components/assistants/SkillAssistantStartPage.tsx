import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { START_PAGE_COPY } from '../../lib/assistants'
import { EmptyState } from '../ui/EmptyState'

/** The Skill assistant start page (stub; the instruction form lands next). */
export default function SkillAssistantStartPage({ project: _project }: { project: Project }): ReactElement {
  const copy = START_PAGE_COPY.skills
  return (
    <div className="new-run" data-testid="assistant-start-skills">
      <div className="new-run-inner">
        <EmptyState title={copy.title} description={copy.description} />
      </div>
    </div>
  )
}
