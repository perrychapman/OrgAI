import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import CodeHome from '../components/home/CodeHome'
import EngagementHome from '../components/home/EngagementHome'
import '../styles/home.css'

/**
 * The Home tab of a stored project: ProjectHome (code, workbench look) or EngagementHome (engagement, serif and coral).
 * Never shown for the assistants (virtual projects; App.tsx). Spec: docs/design/ui-overhaul/project/ProjectHome.dc.html and
 * EngagementHome.dc.html; notes: docs/design/ui-overhaul/impl-project-home.md.
 */
export default function ProjectHomeView({ project }: { project: Project }): ReactElement {
  return projectKindOf(project) === 'engagement' ? <EngagementHome project={project} /> : <CodeHome project={project} />
}
