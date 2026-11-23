import type { ReactElement } from 'react'
import { useId } from 'react'
import type { Project } from '@shared/types'
import { formatUsdCompact } from '@shared/view/cost'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import type { ComposerSendApi } from '../Composer'
import { estimateNote, costText, timeText, useRunEstimate } from './useRunEstimate'
import type { RunEstimateMode } from './useRunEstimate'
import { roleNamesLine, teamGroups, whoCountText } from './newRunData'
import '../../styles/new-run.css'

/** "Ctrl Enter" or "Cmd Enter": both send from the message box (Shift Enter is a new line). */
const SEND_KEYS = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '') ? 'Cmd Enter' : 'Ctrl Enter'

/**
 * The right column of the New run page: who will work on it (the orchestrator, always, then the team's groups, each
 * one a checkbox that leaves the group and everyone below it out of this run), the estimate for exactly that team, and
 * the Start of the page (the composer's own, drawn here) with the way to save the task as a schedule instead.
 */
export function WhoWorksPanel({
  project,
  mode,
  rootName,
  excluded,
  onToggleGroup,
  send,
  startLabel,
  limitUsd,
  onSchedule
}: {
  project: Project
  mode: RunEstimateMode
  rootName: string
  /** Group ids (direct reports of the orchestrator) the user turned off. */
  excluded: readonly string[]
  onToggleGroup: (groupId: string, on: boolean) => void
  /** The composer's send, so Start here is the one Start of the page; null while the composer still shows its own. */
  send: ComposerSendApi | null
  startLabel: string
  /** The limit typed for this run, when valid. */
  limitUsd: number | null
  onSchedule: () => void
}): ReactElement {
  const estimate = useRunEstimate(project.id, mode, excluded)
  const noteId = useId()
  const groups = mode === 'team' ? teamGroups(project.roles) : []
  const root = project.roles.find((r) => r.reportsTo === null)
  const count = mode === 'team' ? whoCountText(project.roles, excluded, project.maxAgentsPerRun) : '1 assistant'
  const note = estimateNote(estimate)
  const cap = limitUsd ?? (typeof project.maxBudgetUsd === 'number' && project.maxBudgetUsd > 0 ? project.maxBudgetUsd : null)
  const promise =
    mode === 'ask'
      ? 'The assistant works in the project folder with this project’s permissions.'
      : cap !== null
        ? `The run pauses and asks at ${formatUsdCompact(cap)}.`
        : 'No spending limit is set for this run.'
  const live = `Likely cost ${costText(estimate)}. Likely time ${timeText(estimate)}.`
  return (
    <aside className="nr-aside nr-glass" aria-label="Who will work on it" data-testid="new-run-who">
      <div className="nr-aside__head">
        <h2 className="nr-aside__title">Who will work on it</h2>
        <span className="nr-aside__count" data-testid="new-run-who-count">
          {count}
        </span>
      </div>

      {mode === 'team' ? (
        <ul className="nr-who">
          <li className="nr-who__row nr-who__row--lead" style={{ ['--role' as string]: root?.color }}>
            <span className="nr-who__mark" aria-hidden="true">
              {rootName.slice(0, 1).toUpperCase()}
            </span>
            <Checkbox
              checked
              disabled
              onChange={() => undefined}
              testId="new-run-role-root"
              title="The orchestrator always works on the run."
              label={
                <>
                  {rootName} <span className="nr-who__n">· always</span>
                </>
              }
              description="Plans the task and hands parts to the team"
            />
          </li>
          {groups.map((g) => {
            const on = !excluded.includes(g.id)
            return (
              <li key={g.id} className={`nr-who__row nr-who__row--group${on ? '' : ' is-off'}`} data-testid="new-run-group" data-on={on} style={{ ['--role' as string]: g.color }}>
                <span className="nr-who__mark nr-who__mark--small" aria-hidden="true" />
                <Checkbox
                  checked={on}
                  onChange={(next) => onToggleGroup(g.id, next)}
                  testId="new-run-group-check"
                  label={
                    <>
                      {g.name}{' '}
                      <span className="nr-who__n">
                        · {g.agents !== null ? `up to ${g.agents}` : `${g.count} ${g.count === 1 ? 'role' : 'roles'}`}
                      </span>
                    </>
                  }
                  description={g.roleNames.length > 1 ? roleNamesLine(g.roleNames) : undefined}
                />
              </li>
            )
          })}
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

      <dl className="nr-estimate" aria-describedby={note ? noteId : undefined} data-testid="new-run-estimate" data-state={estimate.state}>
        <div className="nr-estimate__cell">
          <dt>Likely cost</dt>
          <dd data-testid="new-run-estimate-cost">{costText(estimate)}</dd>
        </div>
        <div className="nr-estimate__cell">
          <dt>Likely time</dt>
          <dd data-testid="new-run-estimate-time">{timeText(estimate)}</dd>
        </div>
      </dl>
      {note && (
        <p className="nr-aside__note" id={noteId} data-testid="new-run-estimate-note">
          {note}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {estimate.state === 'loading' ? '' : live}
      </p>
      <p className="nr-aside__note" data-testid="new-run-promise">
        {promise}
      </p>

      {send && (
        <>
          <Button variant="primary" disabled={!send.canSend} title={send.canSend ? undefined : send.reason} ariaDescribedBy={send.canSend ? undefined : send.reasonId} onClick={send.submit} testId="new-run-start" className="nr-start">
            <span>{startLabel}</span>
            <kbd className="kbd-hint" aria-hidden="true">
              {SEND_KEYS}
            </kbd>
          </Button>
          <span id={send.reasonId} className="sr-only">
            {send.reason}
          </span>
        </>
      )}
      <Button variant="ghost" onClick={onSchedule} testId="new-run-schedule" className="nr-schedule">
        Save as a schedule instead
      </Button>
    </aside>
  )
}
