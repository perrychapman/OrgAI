import type { ReactElement } from 'react'
import type { Effort, ModelTier, Project, Role } from '@shared/types'
import { adapterForProject, adapterOnConnection, modelFamily, roleConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { connectionLabel } from '../../lib/connectionLabel'
import { CONCURRENCY_MAX, CONCURRENCY_MIN, concurrencyText, roleConcurrency, roleStaffingControls, roleStaffingLine, withConcurrency, withMaxEffort, withMinTier, withStaffingMode, type StaffingModeChoice } from '../../lib/roleStaffing'
import { Minus, Plus } from 'lucide-react'
import { Icon } from '../ui/Icon'

/**
 * "How many at once": a 1..8 stepper (the board's count control). Hidden by the inspector until Role carries the field
 * (`ROLE_CONCURRENCY_SUPPORTED`). A real pair of buttons and a polite readout, so it works by keyboard and is announced.
 */
export function RoleConcurrency({ role, onChange }: { role: Role; onChange: (patch: Partial<Role>) => void }): ReactElement {
  const n = roleConcurrency(role)
  const labelId = `role-concurrency-${role.id}`
  return (
    <div className="ri-count" role="group" aria-labelledby={labelId} data-testid="role-concurrency">
      <span className="ri-label" id={labelId}>
        How many at once
      </span>
      <span className="ri-count-value" role="status" aria-live="polite" data-testid="role-concurrency-text">
        {concurrencyText(n)}
      </span>
      <span className="ri-stepper">
        {/* No cap of its own: Fewer starts a cap at the most, More is not offered (there is nothing above "no limit"). */}
        <button
          type="button"
          className="ri-step"
          aria-label="Fewer at once"
          disabled={n !== undefined && n <= CONCURRENCY_MIN}
          data-testid="role-concurrency-less"
          onClick={() => onChange(withConcurrency(n === undefined ? CONCURRENCY_MAX : n - 1))}
        >
          <Icon icon={Minus} size="sm" />
        </button>
        <span className="ri-step-n" aria-hidden="true">
          {n ?? '∞'}
        </span>
        <button
          type="button"
          className="ri-step"
          aria-label={n !== undefined && n >= CONCURRENCY_MAX ? 'No limit of its own' : 'More at once'}
          disabled={n === undefined}
          data-testid="role-concurrency-more"
          onClick={() => onChange(withConcurrency(n === undefined || n >= CONCURRENCY_MAX ? undefined : n + 1))}
        >
          <Icon icon={Plus} size="sm" />
        </button>
      </span>
    </div>
  )
}

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
 * The role editor's "Staffing details" fold: how the model is chosen (mode), the cheapest model the role may use and the
 * most effort it may use, plus the notes that explain a setting that has no effect. The sentence above the fold (see
 * RoleModelSentence) says what the role runs on, so no summary line repeats it here. Saves through updateRoles like the
 * model picker beside it.
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
            <label htmlFor={id('mode')}>How the model is chosen</label>
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
                <label htmlFor={id('min-tier')}>Cheapest model it may use</label>
                <select id={id('min-tier')} className="select" data-testid="role-staffing-min-tier" value={c.minTier} onChange={(e) => write(withMinTier(role, e.target.value as ModelTier | ''))}>
                  {c.minTierOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={id('max-effort')}>Most effort it may use</label>
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
