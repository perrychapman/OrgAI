import type { ReactElement } from 'react'
import type { Project, Role, ToolName } from '@shared/types'
import { TOOL_CATALOG, TOOL_HINTS } from '@shared/types'
import RoleServices from '../connectors/RoleServices'
import RoleSkills from '../skills/RoleSkills'
import { Checkbox } from '../ui/Checkbox'

/**
 * "What it can use": one block with the role's Tools, Connections and Skills. Stub slot of the Team tab: it renders
 * today's editors (tool checkboxes, read-only connections, skills list) and is replaced by the in-place editors with
 * scoped "+ Add" choosers in Brief 2a. `onChange` saves a partial role through the normal project save path.
 */
export default function RoleCapabilities({
  project,
  role,
  onChange
}: {
  project: Project
  role: Role
  onChange: (patch: Partial<Role>) => void
}): ReactElement {
  const toggleTool = (t: ToolName): void => {
    onChange({ tools: role.tools.includes(t) ? role.tools.filter((x) => x !== t) : [...role.tools, t] })
  }
  return (
    <section className="stack-3 role-capabilities" aria-labelledby="role-capabilities-title" data-testid="role-capabilities">
      <h3 className="side-section-title role-capabilities-title" id="role-capabilities-title">
        What it can use
      </h3>
      <section className="stack-2" aria-labelledby="role-tools-title" data-testid="role-tools">
        <h4 className="side-section-title" id="role-tools-title">
          Tools
        </h4>
        <p className="hint">What this role may do on your files and shell.</p>
        <div className="check-grid">
          {TOOL_CATALOG.map((t) => (
            <Checkbox key={t} checked={role.tools.includes(t)} onChange={() => toggleTool(t)} label={t} title={TOOL_HINTS[t]} />
          ))}
        </div>
      </section>
      <RoleServices project={project} role={role} />
      <RoleSkills project={project} role={role} onChange={(skills) => onChange({ skills })} />
    </section>
  )
}
