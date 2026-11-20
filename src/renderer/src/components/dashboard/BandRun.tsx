import type { CSSProperties, ReactElement } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { splitLabelTail } from '@shared/view/agentTree'
import { Cost } from '../ui/Cost'
import { costView, runCostInput } from '../../lib/cost'
import { useArrival } from '../../lib/useArrival'
import { projectHue } from '../../lib/projectIdentity'
import { ProjectBadge } from './ProjectBadge'
import {
  BAND_BREATHING_MAX,
  agentRowName,
  doneText,
  moreAgentsText,
  openedText,
  planProgressText,
  runHeadName,
  type BandAgentRow,
  type BandRow,
  type BandRun as BandRunModel
} from '../../lib/dashboardBand'

/**
 * The agent mark (spec 3.1): role fill, state ring, halo; done and failed carry a glyph. Only the glance row's marks pass
 * `breath` (the stagger index across the band): the first BAND_BREATHING_MAX working ones breathe, the agent rows' own
 * marks stay still so one run never loops twice.
 */
function Mark({ state, color, breath }: { state: BandAgentRow['state']; color: string; breath?: number }): ReactElement {
  const style = { '--role': color, ...(breath !== undefined ? { '--i': breath } : {}) } as CSSProperties
  return (
    <span className="dash-mark" data-state={state} data-breathe={breath !== undefined && breath < BAND_BREATHING_MAX ? '' : undefined} style={style} aria-hidden="true">
      {state === 'done' && <Check size={10} strokeWidth={3} focusable="false" />}
      {state === 'failed' && <TriangleAlert size={10} strokeWidth={3} focusable="false" />}
    </span>
  )
}

function lineStyle(row: BandRow, lineColor?: string): CSSProperties {
  return { '--depth': row.depth, ...(lineColor ? { '--line-role': lineColor } : {}) } as CSSProperties
}

function Label({ text }: { text: string }): ReactElement {
  const { head, tail } = splitLabelTail(text)
  return (
    <span className="dash-pill" title={text}>
      <span className="dash-pill-head">{head}</span>
      {tail && <span className="dash-pill-tail">{tail}</span>}
    </span>
  )
}

export interface BandRunProps {
  run: BandRunModel
  now: number
  onOpen: (projectId: string, runId: string, agentId: string | null, rootId: string | null) => void
  /** Stagger index while this run is arriving (rises in); undefined otherwise. */
  enter?: number
}

/** One run in the band: the header button, then its agent rows (spec 6.3 and 6.4). */
export function BandRun({ run, now, onOpen, enter }: BandRunProps): ReactElement {
  // Agent rows joining a run that is already on screen rise in; the run's own first render never animates (scope = run id).
  const rowArrived = useArrival(run.rows.map((r) => (r.kind === 'agent' ? `a:${r.id}` : r.kind)), run.id, { maxPerBatch: 5 })
  const cost = costView(runCostInput(run.summary), { compact: true })
  const tone = run.status.tone
  const openRoot = (): void => onOpen(run.projectId, run.id, null, run.rootId)
  // One line, cut with an ellipsis; the whole sentence rides in the title.
  const caption = `${run.line2}${run.suffix}`.replace(/^ · /, '')
  const captionFull = `${run.word}${caption ? `: ${caption}` : ''}`
  return (
    <li
      className={enter !== undefined ? 'dash-run motion-enter' : 'dash-run'}
      style={enter !== undefined ? ({ '--i': enter } as CSSProperties) : undefined}
      data-testid="dash-running-row"
      data-status={run.status.word}
      data-run={run.id}
      data-project={run.projectId}
      data-needs={run.decisions > 0 ? run.decisions : undefined}
      data-group={run.group}
      data-hue={projectHue(run.projectId)}
    >
      <button
        type="button"
        className="dash-run-head"
        data-row-main=""
        data-focus-key={`run:${run.id}`}
        style={{ '--line-role': run.rootColor } as CSSProperties}
        title={openedText(run.startedAt, now).replace(/^./, (c) => c.toUpperCase())}
        aria-label={runHeadName(run, cost.empty ? '' : cost.text, now)}
        onClick={openRoot}
      >
        <span className="dash-run-line">
          <ProjectBadge projectId={run.projectId} name={run.projectLabel} size="md" />
          <span className="dash-run-main">
            <span className="dash-run-title">
              <span className="dash-run-name" title={run.name}>
                {run.name}
              </span>
              {run.chip && <span className="dash-chip">{run.chip}</span>}
            </span>
            <span className="dash-run-cap" data-warn={run.decisions > 0 ? 'true' : undefined} title={captionFull}>
              <span className="dash-dot" data-tone={tone} aria-hidden="true" />
              <span className="dash-status">{run.word}</span>
              {caption && <span className="dash-run-cap-text">{caption}</span>}
            </span>
          </span>
          <span className="dash-run-nums">
            <Cost value={runCostInput(run.summary)} compact hideEmpty labelled className="dash-num" />
          </span>
        </span>
        {(run.marks.length > 0 || run.plan) && (
          <span className="dash-run-glance">
            {run.marks.length > 0 && (
              <span className="dash-marks" data-testid="dash-now-marks" data-count={run.marks.length + run.marksMore} aria-hidden="true" title={run.marksSummary}>
                {run.marks.map((m) => (
                  <Mark key={m.id} state={m.state} color={m.color} breath={m.breath} />
                ))}
                {run.marksMore > 0 && <span className="dash-num dash-marks-more">+{run.marksMore}</span>}
              </span>
            )}
            {run.plan && (
              <span
                className="dash-plan-meter"
                data-testid="dash-now-plan"
                data-done={run.plan.done}
                data-total={run.plan.total}
                data-blocked={run.plan.blocked ? 'true' : undefined}
                role="img"
                aria-label={`Plan: ${planProgressText(run.plan)}`}
              >
                <span className="dash-plan-track" aria-hidden="true">
                  <i style={{ width: `${Math.round((run.plan.done / run.plan.total) * 100)}%` }} />
                </span>
                <span className="dash-num dash-plan-text">{planProgressText(run.plan)}</span>
              </span>
            )}
          </span>
        )}
      </button>
      {run.rows.length > 0 && (
        <ul className="dash-agents" aria-label={`Agents in ${run.name}`}>
          {run.rows.map((row) => {
            if (row.kind === 'agent') {
              return (
                <li key={`a:${row.id}`} className={rowArrived(`a:${row.id}`) ? 'motion-enter' : undefined}>
                  <button
                    type="button"
                    className="dash-agent-row"
                    data-testid="dash-agent-row"
                    data-state={row.state}
                    data-agent={row.id}
                    data-run={run.id}
                    data-depth={row.depth}
                    data-through={row.through.join(' ') || undefined}
                    data-last={row.last ? 'true' : undefined}
                    data-focus-key={`agent:${run.id}/${row.id}`}
                    style={lineStyle(row, row.lineColor)}
                    title={row.under ? `${row.label}, under ${row.under}` : undefined}
                    aria-label={agentRowName(row, run.name)}
                    onClick={() => onOpen(run.projectId, run.id, row.id, run.rootId)}
                  >
                    <span className="dash-agent-indent" aria-hidden="true" />
                    <Mark state={row.state} color={row.color} />
                    <Label text={row.label} />
                    {row.role && row.role !== row.label ? <span className="dash-role">{row.role}</span> : <span />}
                    <span className="dash-activity" title={row.under ? `${row.activity} (under ${row.under})` : row.activity}>
                      {row.under ? `under ${row.under} · ` : ''}
                      {row.activity}
                    </span>
                    {row.worktree ? <span className="dash-wt">{row.worktree}</span> : <span />}
                  </button>
                </li>
              )
            }
            const isMore = row.kind === 'more'
            return (
              <li key={isMore ? 'more' : 'done'}>
                <button
                  type="button"
                  className="dash-agent-row dash-agent-summary"
                  data-testid={isMore ? 'dash-agent-more' : 'dash-agent-done'}
                  data-count={row.count}
                  data-failed={row.kind === 'done' ? row.failed : undefined}
                  data-depth={1}
                  data-through={row.through.join(' ') || undefined}
                  data-last={row.last ? 'true' : undefined}
                  data-focus-key={`${row.kind}:${run.id}`}
                  style={lineStyle(row, run.rootColor)}
                  onClick={openRoot}
                >
                  <span className="dash-agent-indent" aria-hidden="true" />
                  <span className="dash-mark" data-state="folded" aria-hidden="true" />
                  <span className="dash-summary-text">
                    {isMore ? moreAgentsText(row.count) : row.failed > 0 ? <>{`${row.count} done, `}<span className="dash-failed">{`${row.failed} failed`}</span></> : doneText(row.count, 0)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
