import type { ReactElement } from 'react'
import { useMemo } from 'react'
import type { Project, Role } from '@shared/types'
import { projectConnection, roleConnection, roleTierContext } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { connectionLabel } from '../../lib/connectionLabel'
import { connectionsViewOf } from '../../lib/roleConnection'
import { roleModelSentenceFor } from '../../lib/roleModelSentence'

/**
 * The one sentence under "Model and effort": what the role runs on and how much effort it may use, in the picker's and
 * the staffing settings' own words. The model id shows only when the role's connection exposes the tier's model.
 */
export default function RoleModelSentence({ project, role }: { project: Project; role: Role }): ReactElement {
  const connection = roleConnection(role, project)
  const list = useAppStore((s) => s.connections)
  const catalog = useAppStore((s) => s.models[connection])
  // The same tier map the Model select beside it lists, so the sentence and the select never disagree.
  const view = useMemo(() => connectionsViewOf(list), [list])
  const tierModels = useMemo(() => roleTierContext(role, project, view, catalog).tierModels, [role, project, view, catalog])
  const pinned = connection !== projectConnection(project) && role.reportsTo !== null ? connectionLabel(connection) : undefined
  return (
    <span className="role-model-sentence" data-testid="role-model-sentence">
      {roleModelSentenceFor(project, role, tierModels, pinned)}
    </span>
  )
}
