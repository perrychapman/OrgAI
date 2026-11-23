import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, CalendarClock, Files, Minus, TriangleAlert } from 'lucide-react'
import type { RunOutput, RunSummary } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Cost } from '../ui/Cost'
import { Icon } from '../ui/Icon'
import { selectedProject, useAppStore } from '../../store/useAppStore'
import { openNewRunWith } from '../home/startRun'
import { formatDuration, runCostInput, sumCosts } from '../../lib/cost'
import { canContinueIn, type ChainGroup } from '../../lib/runChains'
import { displayRunName, isOrgChangeRun, runKindWord } from '../../lib/orgChange'
import { promptLine, runTag, shortPrompt } from '../../lib/runLabels'
import { statusText, type RunStatusView } from '../../lib/runStatus'
import { kindLabel, outputsCountLabel } from '../../lib/outputs'
import { formatDateTime } from '../../lib/dates'
import { agentTally, agentsLabel, branchFacts, branchLines, chainFacts, filesNote, refusalText, rerunPlan, retryPlan, runSummaryText, RERUN_NOT_CARRIED, STEP_WORD, stepTone, tallyText, MARK_WORD, type AgentMark, type OutputsPhase } from '../../lib/runHistory'
import { STATUS_BADGE } from './groupStatus'
import { useRunRecord } from './useRunRecord'

const STEPS_SHOWN = 8
const OUTPUTS_SHOWN = 5
/** The request quoted beside "Run it again" (plain text, one line). */
const REQUEST_CHARS = 140

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
  outputsPhase,
  onOpen,
  onContinue,
  onOpenOutputs
}: {
  group: ChainGroup<RunSummary>
  indexes: Map<string, number>
  status: RunStatusView
  /** The outputs of every session of the conversation, from the loaded index. */
  outputs: RunOutput[]
  /** Whether that index is still loading or failed: then "none" would be a guess. */
  outputsPhase: OutputsPhase
  onOpen: (id: string) => void
  onContinue: (id: string) => void
  onOpenOutputs: (id: string) => void
}): ReactElement {
  const { first, newest, members } = group
  const headingId = useId()
  const tag = runTag(indexes.get(first.id))
  const { record, phase: recordPhase } = useRunRecord(newest)
  const openSchedules = useAppStore((s) => s.openSchedules)
  const project = useAppStore(selectedProject)
  const selectedProjectId = project?.id
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
  const branch = useMemo(() => branchLines(branchFacts(agents)), [agents])
  const root = agents.find((a) => a.parentId === null)
  const summary = runSummaryText({ planSummary: record?.plan?.summary, rootResult: root?.result })
  const steps = record?.plan?.steps ?? []
  const busy = again?.runId === first.id && again.state === 'busy'
  const failure = again?.runId === first.id && again.state === 'error' ? again.message : undefined
  const request = shortPrompt(first.prompt, REQUEST_CHARS)

  // "Run it again" never starts anything: it opens the New run page of the run's own project with the request filled in,
  // so every start guard of that page applies (setup pending, a project that cannot start, the permission-mode
  // confirmation) and the user presses Start there. The guard ref makes a double click or a held Enter act once.
  const opening = useRef(false)
  const armed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    // Another conversation was selected: the guard belongs to the one before.
    opening.current = false
    armed.current = false
    clearTimeout(timer.current)
    setAgain(null)
  }, [first.id])
  // "Try again" continues the failed run and spends tokens, so it never acts on the first press: the first press opens a
  // confirmation that names the project and the request, and only its own button calls runActions.retry. Enter acts on
  // key-up (a held Enter repeats keydown), a ref guard stops a double activation, and a refusal is shown inline.
  const [retry, setRetry] = useState<{ runId: string; state: 'confirm' | 'busy' | 'error'; message?: string } | null>(null)
  const retrying = useRef(false)
  const retryArmed = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const retryOffer = retryPlan(newest, selectedProjectId)
  const retryState = retry?.runId === newest.id ? retry : null
  useEffect(() => {
    retrying.current = false
    retryArmed.current = false
    setRetry(null)
  }, [newest.id])
  useEffect(() => {
    if (retryState?.state === 'confirm') cancelRef.current?.focus()
  }, [retryState?.state])
  const askRetry = (): void => {
    if (!retryOffer.ok) {
      setRetry({ runId: newest.id, state: 'error', message: retryOffer.reason })
      return
    }
    setRetry({ runId: newest.id, state: 'confirm' })
  }
  const confirmRetry = (): void => {
    if (retrying.current || !retryOffer.ok) return
    retrying.current = true
    const runId = newest.id
    setRetry({ runId, state: 'busy' })
    window.orgai.runActions
      .retry({ runId })
      .then((summary) => {
        retrying.current = false
        setRetry(null)
        onOpen(summary.id)
      })
      .catch((e: unknown) => {
        retrying.current = false
        setRetry({ runId, state: 'error', message: refusalText(e, 'The run could not be tried again.') })
      })
  }
  const onRetryKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Enter' || !(e.target instanceof Element) || !e.target.closest('[data-retry-confirm]')) return
    e.preventDefault()
    if (!e.repeat) retryArmed.current = true
  }
  const onRetryKeyUp = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Enter' || !retryArmed.current) return
    retryArmed.current = false
    e.preventDefault()
    confirmRetry()
  }
  const runAgain = (): void => {
    if (opening.current) return
    const plan = rerunPlan(first, selectedProjectId)
    if (!plan.ok) {
      setAgain({ runId: first.id, state: 'error', message: plan.reason })
      return
    }
    opening.current = true
    setAgain({ runId: first.id, state: 'busy' })
    openNewRunWith(first.projectId, plan.text, plan.mode)
    // The page replaces History; if it somehow does not, the button comes back.
    timer.current = setTimeout(() => {
      opening.current = false
      setAgain(null)
    }, 1500)
  }
  // Enter acts once, when the key comes up: a held Enter repeats keydown, and a repeat landing on the composer that the
  // New run page focuses would send the request. Space and the mouse use the button's own click.
  const onAgainKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Enter' || !(e.target instanceof Element) || !e.target.closest('button')) return
    e.preventDefault()
    if (!e.repeat) armed.current = true
  }
  const onAgainKeyUp = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Enter' || !armed.current) return
    armed.current = false
    e.preventDefault()
    runAgain()
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
            <span className="hb-again" onKeyDownCapture={onAgainKeyDown} onKeyUpCapture={onAgainKeyUp} onBlurCapture={() => (armed.current = false)}>
              <Button loading={busy} onClick={runAgain} testId="history-detail-again" ariaDescribedBy={`${headingId}-again`} title="Open the New run page with this request filled in. Nothing is sent until you start it there.">
                Run it again
              </Button>
            </span>
          )}
          {retryOffer.ok && (
            <Button onClick={askRetry} testId="history-detail-retry" inert={retryState?.state === 'busy'} title="Continue this failed run. You confirm before anything is sent.">
              Try again
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
        {canRerun && (
          <p className="hb-note" id={`${headingId}-again`} data-testid="history-again-note">
            Run it again opens the New run page for {project?.name ?? 'this project'} with {'“'}
            {request}
            {'”'} filled in; nothing is sent until you start it there. {RERUN_NOT_CARRIED}
          </p>
        )}
        {(retryState?.state === 'confirm' || retryState?.state === 'busy') && retryOffer.ok && (
          <div className="hb-confirm" role="group" aria-labelledby={`${headingId}-retry`} data-testid="history-retry-confirm-box" onKeyDownCapture={onRetryKeyDown} onKeyUpCapture={onRetryKeyUp} onBlurCapture={() => (retryArmed.current = false)}>
            <p className="hb-note" id={`${headingId}-retry`}>
              Try again continues this failed run in {project?.name ?? 'this project'} and sends {'“'}
              {shortPrompt(retryOffer.request, REQUEST_CHARS)}
              {'”'} to the team. It spends tokens against this project{'’'}s limits. Nothing is sent until you confirm.
            </p>
            <span className="hb-confirm-actions">
              <button type="button" className="btn primary sm" data-retry-confirm="" data-testid="history-retry-confirm" aria-busy={retryState.state === 'busy' || undefined} onClick={() => confirmRetry()}>
                {retryState.state === 'busy' ? 'Starting…' : 'Yes, try again'}
              </button>
              <button type="button" className="btn ghost sm" ref={cancelRef} data-testid="history-retry-cancel" disabled={retryState.state === 'busy'} onClick={() => setRetry(null)}>
                Cancel
              </button>
            </span>
          </div>
        )}
        {retryState?.state === 'error' && (
          <p className="hb-error" role="alert" data-testid="history-retry-error">
            {retryState.message}
          </p>
        )}
        {failure && (
          <p className="hb-error" role="alert" data-testid="history-again-error">
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
            {!record && (
              <p className="hb-note" data-testid="history-left-branches-note">
                {recordPhase === 'loading' ? 'Checking what was merged…' : 'What was merged could not be loaded.'}
              </p>
            )}
            {record && branch.length === 0 && (
              <p className="hb-note" data-testid="history-left-branches-note">
                No merge was recorded for this run.
              </p>
            )}
            {record && branch.length > 0 && (
              <ul className="hb-left" data-testid="history-left-branches">
                {branch.map((l, i) => (
                  <li key={i}>
                    <span className="hb-left-name" title={l.title}>
                      {l.title}
                    </span>
                    {l.note && <span className="hb-left-kind">{l.note}</span>}
                  </li>
                ))}
              </ul>
            )}
            {filesNote(outputsPhase, outputs.length) ? (
              <p className="hb-note" data-testid="history-left-note">
                {filesNote(outputsPhase, outputs.length)}
              </p>
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
                  {outputs.length > OUTPUTS_SHOWN ? `See all ${outputs.length} files` : `Open ${outputsCountLabel(outputs.length)}`}
                </Button>
              </>
            )}
          </section>
        )}

      </div>
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
