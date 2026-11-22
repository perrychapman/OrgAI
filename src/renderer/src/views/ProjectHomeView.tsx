import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'

/**
 * The Home tab of a stored project: ProjectHome (code, workbench look) or EngagementHome (engagement, serif and coral).
 * Stub; built by the Project home brief. Never shown for the assistants (virtual projects).
 */
export default function ProjectHomeView({ project }: { project: Project }): ReactElement {
  const engagement = projectKindOf(project) === 'engagement'
  return <div className={engagement ? 'home-page eng-home' : 'home-page code-home'} data-testid={engagement ? 'engagement-home' : 'project-home'} />
}
