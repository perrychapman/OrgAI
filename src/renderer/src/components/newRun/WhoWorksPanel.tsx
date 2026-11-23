import type { ReactElement } from 'react'
import { useId } from 'react'
import type { Project } from '@shared/types'
import { ESTIMATE_UNKNOWN_TEXT, costText, timeText, useRunEstimate } from './useRunEstimate'
import type { RunEstimateMode } from './useRunEstimate'
import { roleNamesLine, teamGroups } from './newRunData'
import '../../styles/new-run.css'

/**
 * The right column of the New run page: who will work on it (the orchestrator, then the team's groups, information only
 * for now) and the cost and time estimate, which stays "Unknown" until the runtime provides one.
 */
export function WhoWorksPanel({ project, mode, rootName }: { project: Project; mode: RunEstimateMode; rootName: string }): ReactElement {
  const estimate = useRunEstimate(project.id, mode)
  const noteId = useId()
  const groups = mode === 'team' ? teamGroups(project.roles) : []
  const roleCount = project.roles.length
  const rootColor = project.roles.find((r) => r.reportsTo === null)?.color
  return (
    <aside className="nr-aside nr-glass" aria-label="Who will work on it" data-testid="new-run-who">
      <div className="nr-aside__head">
        <h2 className="nr-aside__title">Who will work on it</h2>
        <span className="nr-aside__count">{mode === 'team' ? `${roleCount} ${roleCount === 1 ? 'role' : 'roles'}` : '1 assistant'}</span>
      </div>

      {mode === 'team' ? (
        <ul className="nr-who">
          <li className="nr-who__row nr-who__row--lead" style={{ ['--role' as string]: rootColor }}>
            <span className="nr-who__mark" aria-hidden="true">
              {rootName.slice(0, 1).toUpperCase()}
            </span>
            <span className="nr-who__text">
              <span className="nr-who__name">{rootName}</span>
              <span className="nr-who__sub">Plans the task and hands parts to the team</span>
            </span>
            <span className="nr-who__tag">always</span>
          </li>
          {groups.map((g) => (
            <li key={g.id} className="nr-who__row nr-who__row--group" data-testid="new-run-group" style={{ ['--role' as string]: g.color }}>
              <span className="nr-who__mark nr-who__mark--small" aria-hidden="true" />
              <span className="nr-who__text">
                <span className="nr-who__name">
                  {g.name}{' '}
                  <span className="nr-who__n">
                    · {g.count} {g.count === 1 ? 'role' : 'roles'}
                  </span>
                </span>
                <span className="nr-who__sub">{roleNamesLine(g.roleNames)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="nr-who__row nr-who__row--solo">
          <span className="nr-who__mark" aria-hidden="true">
            A
          </span>
          <span className="nr-who__text">
            <span className="nr-who__name">One assistant</span>
            <span className="nr-who__sub">No team, no plan. Best for a quick, contained task.</span>
          </span>
        </div>
      )}

      <dl className="nr-estimate" aria-describedby={estimate.state === 'unknown' ? noteId : undefined} data-testid="new-run-estimate" data-state={estimate.state}>
        <div className="nr-estimate__cell">
          <dt>Likely cost</dt>
          <dd>{costText(estimate)}</dd>
        </div>
        <div className="nr-estimate__cell">
          <dt>Likely time</dt>
          <dd>{timeText(estimate)}</dd>
        </div>
      </dl>
      {estimate.state === 'unknown' && (
        <p className="nr-aside__note" id={noteId}>
          {ESTIMATE_UNKNOWN_TEXT}.
        </p>
      )}
    </aside>
  )
}
