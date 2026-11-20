import type { ReactElement } from 'react'
import type { Role } from '@shared/types'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { delegationView } from '../../lib/delegation'
import { withRequiredReport, withSpawnableToggled } from '../../lib/roleOps'

const ALWAYS_TITLE = 'Every time this role finishes, the team must hand a task to this one.'

/** The role dot and name of one row. The name is cut with an ellipsis; the full name is the title. */
function RoleName({ r }: { r: Role }): ReactElement {
  return (
    <span className="rd-name" title={r.name}>
      <span className="avatar xs" style={{ ['--role' as string]: r.color }} aria-hidden="true" />
      <span className="rd-name-text">{r.name}</span>
    </span>
  )
}

/**
 * "Who it can delegate to" (docs/design/team-tab-overhaul.md 1.6). A role delegates to its own direct reports by default;
 * a role on another branch is an explicit choice behind a closed disclosure. The role's manager chain is never offered:
 * one the data already ticks shows as a single removable line.
 */
export default function RoleDelegation({
  roles,
  role,
  onChange,
  onAddReport,
  headingId
}: {
  roles: readonly Role[]
  role: Role
  onChange: (patch: Partial<Role>) => void
  onAddReport?: () => void
  /** The section heading's id, for the groups' accessible names. */
  headingId: string
}): ReactElement {
  const view = delegationView(roles, role)
  const toggle = (rid: string): void => onChange(withSpawnableToggled(role, rid))

  const delegateBox = (r: Role): ReactElement => (
    <Checkbox
      checked={role.spawnable.includes(r.id)}
      onChange={() => toggle(r.id)}
      testId={`role-delegate-${r.slug}`}
      label={
        <>
          Can delegate to it<span className="sr-only">: {r.name}</span>
        </>
      }
    />
  )

  return (
    <div className="stack-2" data-testid="role-delegation">
      <Checkbox
        checked={role.canSpawn}
        onChange={(v) => onChange({ canSpawn: v })}
        testId="role-can-delegate"
        label="Can hand work to other roles"
        description="Turn this off to make it a role that only does the work it is given."
      />
      {role.canSpawn && (
        <>
          <div className="stack-1" role="group" aria-labelledby={`${headingId}-direct`}>
            <span className="field-label" id={`${headingId}-direct`}>
              Direct reports
            </span>
            {view.direct.length > 0 ? (
              <ul className="rd-list">
                {view.direct.map((r) => (
                  <li key={r.id} className="rd-row" data-testid={`role-delegate-row-${r.slug}`}>
                    <RoleName r={r} />
                    <div className="rd-checks">
                      {delegateBox(r)}
                      <Checkbox
                        checked={(role.requiredReports ?? []).includes(r.id)}
                        onChange={(v) => onChange(withRequiredReport(role, r.id, v))}
                        disabled={!role.spawnable.includes(r.id)}
                        title={ALWAYS_TITLE}
                        testId={`role-required-report-${r.slug}`}
                        label={
                          <>
                            Always involve<span className="sr-only">: {r.name}</span>
                          </>
                        }
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rd-empty" data-testid="role-delegate-empty">
                No reports yet. Add a role that reports to {role.name || 'this role'} to delegate work.
                {onAddReport && (
                  <>
                    {' '}
                    <button type="button" className="link-btn" data-testid="role-add-report" onClick={onAddReport}>
                      Add a report
                    </button>
                  </>
                )}
              </p>
            )}
          </div>

          {view.tickedAncestors.length > 0 && (
            <ul className="rd-list rd-up" data-testid="role-delegate-up">
              {view.tickedAncestors.map((r) => (
                <li key={r.id} className="rd-up-row">
                  <span className="rd-up-text">
                    Also delegates to {r.id === role.reportsTo ? 'its manager ' : ''}
                    <strong title={r.name}>{r.name}</strong>.
                  </span>
                  <Button size="sm" variant="ghost" testId={`role-delegate-up-remove-${r.slug}`} ariaLabel={`Stop delegating to ${r.name}`} onClick={() => toggle(r.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {view.otherCount > 0 && (
            <details className="rd-other" open={view.otherTicked > 0} data-testid="role-delegate-other">
              <summary>
                <span className="rd-other-head">
                  <span>
                    Roles on other branches <span className="muted">({view.otherCount})</span>
                  </span>
                  {view.otherTicked > 0 && (
                    <span className="chip" data-testid="role-delegate-other-chip">
                      {view.otherTicked} on other branches
                    </span>
                  )}
                </span>
              </summary>
              <div className="stack-2 rd-other-body">
                <p className="rd-note">Delegating across branches skips the roles in between. Use it only when you mean it.</p>
                {view.branches.map((g) => {
                  // A branch of one role that heads itself needs no heading: the row is the branch.
                  const single = g.roles.length === 1 && g.roles[0].id === g.head.id
                  return (
                  <div key={g.head.id} className="stack-1" role={single ? undefined : 'group'} aria-label={single ? undefined : `${g.head.name} branch`}>
                    {!single && <span className="field-label">{g.head.name} branch</span>}
                    <ul className="rd-list">
                      {g.roles.map((r) => (
                        <li key={r.id} className="rd-row">
                          <RoleName r={r} />
                          <div className="rd-checks">{delegateBox(r)}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  )
                })}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}
