import type { ReactElement } from 'react'
import type { Effort, ModelTier, Project, Role } from '@shared/types'
import { adapterForProject, adapterOnConnection, modelFamily, roleConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { connectionLabel } from '../../lib/connectionLabel'
import { roleStaffingControls, roleStaffingLine, withMaxEffort, withMinTier, withStaffingMode, type StaffingModeChoice } from '../../lib/roleStaffing'

/** The model a role effectively runs on: its own, or through its parents when it inherits. */
function effectiveModel(project: Project, role: Role): string | undefined {
  let cur: Role | undefined = role
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.model !== 'inherit') return cur.model
    cur = project.roles.find((r) => r.id === cur!.reportsTo)
  }
  return undefined
}

/**
 * "Model and effort" in the role editor: one line saying what the role's model and effort mean now, and the controls
 * for staffing (mode, lowest tier, highest effort). Saves through updateRoles like the model picker beside it.
 */
export default function RoleStaffingControls({ project, role }: { project: Project; role: Role }): ReactElement {
  const updateRoles = useAppStore((s) => s.updateRoles)
  const connection = roleConnection(role, project)
  const catalog = useAppStore((s) => s.models[connection])
  const isRoot = role.reportsTo === null
  const model = effectiveModel(project, role)
  const family = model ? (catalog?.find((m) => m.id === model)?.family ?? modelFamily(model)) : undefined
  const adapter = isRoot ? adapterForProject(project, catalog ?? []).adapter : adapterOnConnection(connection, family)
  const line = roleStaffingLine(role, project, isRoot)
  const c = roleStaffingControls(role, project, adapter, connectionLabel(connection))
  const id = (name: string): string => `role-staffing-${name}-${role.id}`

  const write = (staffing: Role['staffing']): void => {
    updateRoles(project.id, (roles) =>
      roles.map((r) => {
        if (r.id !== role.id) return r
        const { staffing: _old, ...rest } = r
        return staffing ? { ...rest, staffing } : rest
      })
    )
  }

  return (
    <div className="role-staffing stack-2" data-testid="role-staffing" data-kind={c.kind}>
      <p className="role-staffing-line" data-testid="role-staffing-line">
        <strong>Model and effort:</strong> {line.text}
      </p>
      {line.note && (
        <span className="hint" data-testid="role-staffing-note">
          {line.note}
        </span>
      )}
      {c.explanation && (
        <span className="hint" data-testid="role-staffing-explain">
          {c.explanation}
        </span>
      )}
      {c.kind === 'editable' && (
        <>
          <div className="field">
            <label htmlFor={id('mode')}>Staffing</label>
            <select id={id('mode')} className="select" data-testid="role-staffing-mode" value={c.mode} onChange={(e) => write(withStaffingMode(role, e.target.value as StaffingModeChoice))}>
              {c.modeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {c.showBounds && (
            <>
              <div className="field">
                <label htmlFor={id('min-tier')}>Lowest tier</label>
                <select id={id('min-tier')} className="select" data-testid="role-staffing-min-tier" value={c.minTier} onChange={(e) => write(withMinTier(role, e.target.value as ModelTier | ''))}>
                  {c.minTierOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={id('max-effort')}>Highest effort</label>
                <select id={id('max-effort')} className="select" data-testid="role-staffing-max-effort" value={c.maxEffort} onChange={(e) => write(withMaxEffort(role, e.target.value as Effort | ''))}>
                  {c.maxEffortOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
