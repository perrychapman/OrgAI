import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { FolderListSection } from './AllowedDirectoriesSection'

/** Project settings > Permissions > Reference folders (read only) (`Project.referenceDirectories`). */
export function ReferenceDirectoriesSection({ project }: { project: Project }): ReactElement {
  return <FolderListSection project={project} kind="reference" />
}
