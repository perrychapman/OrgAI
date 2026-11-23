import type { ReactElement } from 'react'
import { useId, useMemo, useState } from 'react'
import { Check, CalendarClock, Files, Minus, TriangleAlert } from 'lucide-react'
import type { RunOutput, RunSummary } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Cost } from '../ui/Cost'
import { Icon } from '../ui/Icon'
import { useConfirm } from '../ui/ConfirmDialog'
import { useAppStore } from '../../store/useAppStore'
import { formatDuration, runCostInput, sumCosts } from '../../lib/cost'
import { canContinueIn, type ChainGroup } from '../../lib/runChains'
import { displayRunName, isOrgChangeRun, runKindWord } from '../../lib/orgChange'
import { promptLine, runTag } from '../../lib/runLabels'
import { statusText, type RunStatusView } from '../../lib/runStatus'
import { kindLabel, outputsCountLabel } from '../../lib/outputs'
import { cleanIpcError } from '../../lib/ipcError'
import { formatDateTime } from '../../lib/dates'
import { agentTally, agentsLabel, chainFacts, runSummaryText, STEP_WORD, stepTone, tallyText, MARK_WORD, type AgentMark } from '../../lib/runHistory'
import { STATUS_BADGE } from './groupStatus'
import { useRunRecord } from './useRunRecord'

const STEPS_SHOWN = 8
const OUTPUTS_SHOWN = 5

const MARK_ORDER: readonly AgentMark[] = ['error', 'waiting', 'working', 'idle', 'done']

/**
 * The selected conversation, to the right of the list: status, name, when, what the team said it did, three numbers, the
 * agents, the plan's steps, what it produced and the actions. Everything comes from the run summaries, the run record or
 * the outputs index; a section whose facts do not exist is left out and nothing is estimated.
 */
export function HistoryDetail({
  group,
  indexes,
  status,
  outputs,
  onOpen,
  onContinue,
  onOpenOutputs
}: {
  group: ChainGroup<RunSummary>
  indexes: Map<string, number>
  status: RunStatusView
  /** The outputs of every session of the conversation, from the loaded index. */
  outputs: RunOutput[]
  onOpen: (id: string) => void
  onContinue: (id: string) => void
  onOpenOutputs: (id: string) => void
}): ReactElement {
  const { first, newest, members } = group
  const headingId = useId()
  const tag = runTag(indexes.get(first.id))
  const record = useRunRecord(newest)
  const startRun = useAppStore((s) => s.startRun)
  const openSchedules = useAppStore((s) => s.openSchedules)
  const { confirm, dialog } = useConfirm()
  const [again, setAgain] = useState<{ runId: string; state: 'busy' | 'error'; message?: string } | null>(null)
  const orgChange = isOrgChangeRun(first)
  const name = first.title || orgChange ? displayRunName(first) : promptLine(first.prompt)
  const facts = useMemo(() => chainFacts(members), [members])
  const cost = useMemo(() => sumCosts(members.map(runCostInput)), [members])
  const scheduleId = members.find((m) => m.scheduleId)?.scheduleId
  const scheduleName = members.find((m) => m.scheduleName)?.scheduleName
  const canRerun = first.kind === 'work' && !first.quick && !isVirtualProjectId(first.projectId) && first.prompt.trim().length > 0
  const canContinue = canContinueIn(members, newest.id)

  const agents = useMemo(() => (record ? Object.values(record.agents ?? {}) : []), [record])
  const tally = useMemo(() => agentTally(agents.map((a) => a.state)), [agents])
  const root = agents.find((a) => a.parentId === null)
  const summary = runSummaryText({ planSummary: record?.plan?.summary, rootResult: root?.result })
  const steps = record?.plan?.steps ?? []
  const busy = again?.runId === first.id && again.state === 'busy'
  const failure = again?.runId === first.id && again.state === 'error' ? again.message : undefined

  const runAgain = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Run it again?',
      body: 'This starts a new run with the same request and the team as it is now. It uses your plan or budget like any other run.',
      confirmLabel: 'Run it again'
    })
    if (!ok) return
    setAgain({ runId: first.id, state: 'busy' })
    try {
      await startRun(first.prompt, first.team === 'single' ? { team: 'single' } : undefined)
      setAgain(null)
    } catch (e) {
      setAgain({ runId: first.id, state: 'error', message: cleanIpcError(e, 'Could not start the run.') })
    }
  }

  const startedText = formatDateTime(first.startedAt)
  const meta = [startedText, runKindWord(first), members.length > 1 ? `${members.length} sessions` : '', scheduleName ? `Scheduled: ${scheduleName}` : ''].filter(Boolean).join(' · ')

  return (
    <aside className="hb-detail glass" aria-labelledby={headingId} data-testid="history-detail" data-chain={group.key}>
      <div className="hb-detail-body motion-fade" key={group.key}>
        <header className="hb-detail-head">
          <Badge tone={STATUS_BADGE[status.tone]} title={newest.pauseReason ?? status.note} testId="history-detail-status">
            <span className="hb-dot hb-dot-sm" data-tone={status.tone} aria-hidden="true" />
            {statusText(status)}
          </Badge>
          <h3 id={headingId} className="hb-detail-title">
            <span className="run-index">{tag}</span> {name}
          </h3>
          <p className="hb-detail-meta">{meta}</p>
        </header>

        {summary && <p className="hb-summary">{summary}</p>}
        {!summary && newest.error && status.word === 'Failed' && <p className="hb-summary hb-summary-bad">{newest.error.split(/\r?\n/)[0].slice(0, 300)}</p>}

        <dl className="hb-stats" aria-label="Totals for this conversation">
          <div>
            <dt>Agents</dt>
            <dd className="tabular">{facts.agents === null ? <Unknown /> : facts.agents}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd className="tabular">{facts.wallMs === null ? <Unknown /> : formatDuration(facts.wallMs)}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd className="tabular">
              <Cost value={cost} />
            </dd>
          </div>
        </dl>

        {/* The actions sit under the numbers, not at the foot of a long panel: on a short window they stay in view. */}
        <div className="hb-actions-row">
          <Button variant="primary" onClick={() => onOpen(newest.id)} testId="history-detail-open">
            Open the run
          </Button>
          {canRerun && (
            <Button loading={busy} onClick={() => void runAgain()} testId="history-detail-again" title="Start a new run with the same request">
              Run it again
            </Button>
          )}
          {canContinue && (
            <Button onClick={() => onContinue(newest.id)} testId="history-detail-continue" title="Open this run and continue its session with its memory">
              Continue from here
            </Button>
          )}
          {scheduleId && (
            <Button variant="ghost" icon={CalendarClock} testId="history-detail-schedule" onClick={() => openSchedules({ scheduleId })}>
              Open the schedule
            </Button>
          )}
        </div>
        {failure && (
          <p className="hb-error" role="alert">
            {failure}
          </p>
        )}

        {tally.total > 0 && (
          <section className="hb-section" aria-label="Agents in the latest session">
            <h4 className="hb-section-title">Agents</h4>
            <div className="hb-marks" role="img" aria-label={`${agentsLabel(tally.total)} in the latest session: ${tallyText(tally)}`} data-testid="history-agent-marks">
              {tally.marks.map((m, i) => (
                <span key={i} className="hb-mark" data-mark={m} />
              ))}
              {tally.more > 0 && <span className="hb-marks-more">+{tally.more}</span>}
            </div>
            <p className="hb-note">
              {MARK_ORDER.filter((m) => tally.counts[m] > 0)
                .map((m) => `${tally.counts[m]} ${MARK_WORD[m]}`)
                .join(' · ')}
              {members.length > 1 ? ' (latest session)' : ''}
            </p>
          </section>
        )}

        {steps.length > 0 && (
          <section className="hb-section" aria-labelledby={`${headingId}-steps`}>
            <h4 className="hb-section-title" id={`${headingId}-steps`}>
              How it went
            </h4>
            <ol className="hb-steps" data-testid="history-steps">
              {steps.slice(0, STEPS_SHOWN).map((s) => {
                const tone = stepTone(s.status)
                return (
                  <li key={s.id} className="hb-step" data-tone={tone}>
                    <span className="hb-step-mark" aria-hidden="true">
                      {tone === 'ok' && <Icon icon={Check} size="xs" />}
                      {tone === 'bad' && <Icon icon={TriangleAlert} size="xs" />}
                      {tone === 'skipped' && <Icon icon={Minus} size="xs" />}
                    </span>
                    <span className="hb-step-text">
                      {s.title}
                      <span className="sr-only">: {STEP_WORD[s.status]}</span>
                    </span>
                  </li>
                )
              })}
            </ol>
            {steps.length > STEPS_SHOWN && <p className="hb-note">{steps.length - STEPS_SHOWN} more steps in the run.</p>}
          </section>
        )}

        {first.kind === 'work' && !first.quick && (
          <section className="hb-section" aria-labelledby={`${headingId}-left`}>
            <h4 className="hb-section-title" id={`${headingId}-left`}>
              What it left
            </h4>
            {outputs.length === 0 ? (
              <p className="hb-note">No outputs registered.</p>
            ) : (
              <>
                <ul className="hb-left" data-testid="history-left">
                  {outputs.slice(0, OUTPUTS_SHOWN).map((o) => (
                    <li key={o.id}>
                      <span className="hb-left-name" title={o.relPath}>
                        {o.title}
                      </span>
                      <span className="hb-left-kind">{kindLabel(o.kind)}</span>
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="ghost" icon={Files} testId="history-detail-outputs" onClick={() => onOpenOutputs(newest.id)}>
                  {outputs.length > OUTPUTS_SHOWN ? `See all ${outputs.length} outputs` : `Open ${outputsCountLabel(outputs.length)}`}
                </Button>
              </>
            )}
          </section>
        )}

      </div>
      {dialog}
    </aside>
  )
}

function Unknown(): ReactElement {
  return (
    <span title="Not recorded for this run">
      <span aria-hidden="true">{'–'}</span>
      <span className="sr-only">unknown</span>
    </span>
  )
}
