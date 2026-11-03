import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import McpSection from '../mcp/McpSection'
import PluginsSection from '../mcp/PluginsSection'
import SkillsSection from '../skills/SkillsSection'

/**
 * Catalog tab of the Team panel: the project's home for skills, connections and plugins. Each item lists who uses it
 * ("Used by" chips select that role and switch to the Role tab through `onSelectRole`). Credentials and sign-in stay in
 * App settings > Connectors.
 */
export default function TeamCatalog({ project, onSelectRole }: { project: Project; onSelectRole?: (roleId: string) => void }): ReactElement {
  return (
    <div className="side-body stack-3 team-catalog" data-testid="team-catalog">
      <p className="hint">What the whole team can draw on. Open a role to choose what it uses.</p>
      <SkillsSection project={project} onSelectRole={onSelectRole} />
      <McpSection project={project} onSelectRole={onSelectRole} />
      <PluginsSection project={project} />
    </div>
  )
}
