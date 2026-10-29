import type { ReactElement } from 'react'
import type { Project } from '@shared/types'

/** Stub: the UI Engineer replaces this with the plugins section. */
export default function PluginsSection({ project }: { project: Project }): ReactElement {
  return <section id="settings-section-plugins" data-project={project.id} />
}
