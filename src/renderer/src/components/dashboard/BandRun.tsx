import type { CSSProperties, ReactElement } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { splitLabelTail } from '@shared/view/agentTree'
import { Cost } from '../ui/Cost'
import { costView, runCostInput } from '../../lib/cost'
import {
  agentRowName,
  doneText,
  moreAgentsText,
  openedText,
  runHeadName,
  type BandAgentRow,
  type BandRow,
  type BandRun as BandRunModel
} from '../../lib/dashboardBand'

/** At most this many marks breathe (the wide cap, spec 3.4). */
const MAX_BREATHING = 12

/** The agent mark (spec 3.1): role fill, state ring, halo; done and failed carry a glyph. */
function Mark({ state, color, breath }: { state: BandAgentRow['state']; color: string; breath?: number }): ReactElement {
  const style = { '--role': color, ...(breath !== undefined ? { '--i': breath } : {}) } as CSSProperties
  return (
    <span className="dash-mark" data-state={state} data-breathe={breath !== undefined && breath < MAX_BREATHING ? '' : undefined} style={style} aria-hidden="true">
      {state === 'done' && <Check size={10} strokeWidth={3} focusable="false" />}
      {state === 'failed' && <TriangleAlert size={10} strokeWidth={3} focusable="false" />}
    </span>
  )
}

/** The interchange mark of a run header: a ring in the root's role colour around a dot. */
function Interchange({ color, tone }: { color: string; tone: BandRunModel['group'] }): ReactElement {
  return <span className="dash-mark" data-root="" data-group={tone} style={{ '--role': color } as CSSProperties} aria-hidden="true" />
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
}

/** One run in the band: the header button, then its agent rows (spec 6.3 and 6.4). */
export function BandRun({ run, now, onOpen }: BandRunProps): ReactElement {
  const cost = costView(runCostInput(run.summary), { compact: true })
  const tone = run.status.tone
  const openRoot = (): void => onOpen(run.projectId, run.id, null, run.rootId)
  return (
    <li
      className="dash-run"
      data-testid="dash-running-row"
      data-status={run.status.word}
      data-run={run.id}
      data-project={run.projectId}
      data-needs={run.decisions > 0 ? run.decisions : undefined}
      data-group={run.group}
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
          <Interchange color={run.rootColor} tone={run.group} />
          <span className="dash-dot" data-tone={tone} aria-hidden="true" />
          <span className="dash-status">{run.word}</span>
          <span className="dash-run-name">{run.name}</span>
          {run.chip && <span className="dash-chip">{run.chip}</span>}
          <span className="dash-run-nums">
            {run.planStep && <span className="dash-num dash-plan">{run.planStep}</span>}
            <Cost value={runCostInput(run.summary)} compact hideEmpty labelled className="dash-num" />
          </span>
        </span>
        <span className="dash-run-cap" data-warn={run.decisions > 0 ? 'true' : undefined}>
          {run.line2}
          {run.suffix}
        </span>
      </button>
      {run.rows.length > 0 && (
        <ul className="dash-agents" aria-label={`Agents in ${run.name}`}>
          {run.rows.map((row) => {
            if (row.kind === 'agent') {
              return (
                <li key={`a:${row.id}`}>
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
                    <Mark state={row.state} color={row.color} breath={row.breath} />
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
