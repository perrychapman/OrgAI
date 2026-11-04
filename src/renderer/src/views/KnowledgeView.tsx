import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import '../styles/knowledge.css'

/**
 * The Knowledge tab (docs/design/knowledge.md): the engagement's entities, relations, facts and context notes, as a
 * filterable list with a detail pane, or as a graph. Placeholder until the list lands (ui-engineer-1 replaces this file).
 */
export default function KnowledgeView({ project }: { project: Project }): ReactElement {
  return (
    <div className="knowledge" data-testid="knowledge-view" data-project={project.id}>
      <p className="panel-note">Knowledge is not built yet.</p>
    </div>
  )
}
