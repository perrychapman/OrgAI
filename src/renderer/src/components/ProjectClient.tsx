import type { ReactElement } from 'react'
import { projectKindOf } from '@shared/defaults'
import { isVirtualProjectId, type Project } from '@shared/types'
import { clientOf } from '../lib/clientGroups'

/** The engagement's client as quiet text after the project name in the topbar. User text: rendered as a text node, clamped by CSS. */
export default function ProjectClient({ project }: { project: Project | null | undefined }): ReactElement | null {
  if (!project || isVirtualProjectId(project.id) || projectKindOf(project) !== 'engagement') return null
  const client = clientOf(project)
  if (!client) return null
  return (
    <span className="project-client" data-testid="project-client" title={client}>
      {client}
    </span>
  )
}
