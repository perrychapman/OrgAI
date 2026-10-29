import type { ReactElement } from 'react'
import type { Project } from '@shared/types'

/** Stub: the UI Engineer replaces this with the MCP servers section. */
export default function McpSection({ project }: { project: Project }): ReactElement {
  return <section id="settings-section-mcp" data-project={project.id} />
}
