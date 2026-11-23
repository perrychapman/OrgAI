import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { RUN_ADD_BUDGET_MAX_USD, type RunHoldAction } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { holdOf } from '../../lib/runHold'
import { money } from '../../lib/usage'
import '../../styles/run-hold.css'

export interface RunHoldCardProps {
  runId: string
  canContinue: boolean
  sessionOpen: boolean
  /** Focuses the composer (plan-blocked Answer, failed Continue). */
  onAnswer: () => void
  /** Opens the plan side tab. */
  onShowPlan: () => void
  /** Focuses the composer's model switch; the "switch model" choice shows only when given. */
  onSwitchModel?: () => void
}

interface Option {
  action: RunHoldAction
  label: string
  detail: string
  /** The primary button's text when this option is chosen. */
  button: string
}

const DEFAULT_ADD_USD = 5

/** The amount the user typed, or null when it is not a usable number. */
function parseAmount(text: string): number | null {
  const n = Number(text.trim())
  return text.trim() !== '' && Number.isFinite(n) && n > 0 && n <= RUN_ADD_BUDGET_MAX_USD ? n : null
}

/** The card that says what stopped a run and what the user can do about it. Renders nothing when nothing holds the run. */
export function RunHoldCard({ runId, canContinue, sessionOpen, onAnswer, onShowPlan, onSwitchModel }: RunHoldCardProps): ReactElement | null {
  const summary = useAppStore((s) => s.runs[runId]?.summary)
  const plan = useAppStore((s) => s.runs[runId]?.plan)
  const resumeNow = useAppStore((s) => s.resumeNow)
  const cancelAutoResume = useAppStore((s) => s.cancelAutoResume)
  const addBudget = useAppStore((s) => s.addBudget)
  const retryRun = useAppStore((s) => s.retryRun)
  const skipReview = useAppStore((s) => s.skipReview)
  const stopRun = useAppStore((s) => s.stopRun)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<RunHoldAction | null>(null)
  const [amountText, setAmountText] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [hintShown, setHintShown] = useState(false)
  // A second activation before the first has settled (key repeat, double click) is dropped; spending and gate changes ask first.
  const actingRef = useRef(false)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const titleId = useId()
  const groupId = useId()
  const amountId = useId()
  const amountHelpId = useId()
  const noteId = useId()

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const hold = holdOf(summary, plan, { now, sessionOpen })
  if (!hold) return null

  const act = async (fn: () => Promise<void> | void): Promise<void> => {
    if (actingRef.current) return
    actingRef.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      actingRef.current = false
      setBusy(false)
    }
  }
  /** Asks first, naming what the action does; nothing runs unless the user confirms. A refusal from main shows inline. */
  const confirmed = async (opts: Parameters<typeof confirm>[0], fn: () => Promise<void>): Promise<void> => {
    if (actingRef.current) return
    if (!(await confirm(opts))) return
    await act(fn)
  }

  const kind = hold.kind
  const has = (a: RunHoldAction): boolean => hold.actions.includes(a)
  const options: Option[] = []
  if (has('resume')) options.push({ action: 'resume', label: 'Resume now', detail: 'Continue now instead of waiting for the reset.', button: 'Resume now' })
  if (has('addBudget')) options.push({ action: 'addBudget', label: 'Add to the limit', detail: 'Raise this run’s limit and pick up where it stopped.', button: 'Add and continue' })
  if (has('retry')) {
    const label = kind === 'provider' ? 'Try again' : 'Continue'
    options.push({ action: 'retry', label, detail: kind === 'provider' ? 'Same connection, same model.' : 'Pick up where it stopped.', button: label })
  }
  if (has('switchModel') && onSwitchModel) options.push({ action: 'switchModel', label: 'Use another model', detail: sessionOpen ? 'Pick one in the box below.' : 'Pick one below; it is used when you continue.', button: 'Switch model' })
  if (has('skipReview')) options.push({ action: 'skipReview', label: 'Skip review for this change', detail: 'Tell the orchestrator to go ahead without the review step.', button: 'Skip review for this change' })

  const choose = options.length > 1
  const chosen = options.find((o) => o.action === picked) ?? options[0]
  const amount = amountText ?? String(Math.min(RUN_ADD_BUDGET_MAX_USD, hold.limitUsd && hold.limitUsd > 0 ? hold.limitUsd : DEFAULT_ADD_USD))
  const parsed = parseAmount(amount)
  const amountBad = chosen?.action === 'addBudget' && parsed === null
  const canAnswer = sessionOpen || canContinue

  const run = (o: Option): void => {
    switch (o.action) {
      case 'resume':
        return void act(() => resumeNow(runId))
      case 'addBudget':
        if (parsed === null) return
        return void confirmed(
          { title: `Add ${money(parsed)} to this run?`, body: `This raises this run’s spending limit by ${money(parsed)} and lets it continue, so it can spend up to that much more. Your project limits still apply.`, confirmLabel: `Add ${money(parsed)} and continue`, confirmTestId: 'run-hold-confirm' },
          () => addBudget(runId, parsed)
        )
      case 'retry':
        return void act(() => retryRun(runId))
      case 'switchModel':
        setHintShown(!sessionOpen)
        return onSwitchModel?.()
      case 'skipReview':
        return void confirmed(
          { title: 'Skip the review for this change?', body: 'The change goes ahead without the review step. Merge review still asks before anything is merged.', confirmLabel: 'Skip review for this change', danger: true, confirmTestId: 'run-hold-confirm' },
          () => skipReview(runId, note.trim() || undefined)
        )
      default:
        return
    }
  }

  const rootClass = kind === 'usage-limit' ? 'run-hold pause-banner' : kind === 'plan-blocked' ? 'run-hold pause-banner plan-blocked-banner' : 'run-hold'
  const failedBody = kind === 'failed'

  return (
    <>
    <section className={rootClass} aria-labelledby={titleId} data-testid="run-hold" data-kind={kind} data-tone={hold.tone}>
      <div className="run-hold-head" role="status">
        <span className="run-hold-pill" data-tone={hold.tone}>
          <span className={hold.tone === 'failed' ? 'run-hold-dot' : hold.tone === 'retrying' ? 'run-hold-dot motion-pulse' : 'run-hold-dot motion-breathe'} aria-hidden="true" />
          {hold.word}
        </span>
        <span className="run-hold-safe">{hold.safe}</span>
      </div>
      <div className="run-hold-body" data-testid={failedBody ? 'run-error' : undefined}>
        <h2 id={titleId} className="run-hold-title">
          {hold.title}
        </h2>
        <p className="run-hold-text">{hold.text}</p>
      </div>

      {hold.facts.length > 0 && (
        <dl className="run-hold-facts">
          {hold.facts.map((f) => (
            <div key={f.label} className="run-hold-fact">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {choose && (
        <div role="radiogroup" aria-label="What to do" className="run-hold-options">
          {options.map((o) => (
            <label key={o.action} className="run-hold-option" data-checked={o === chosen ? 'true' : undefined}>
              <input type="radio" name={groupId} value={o.action} checked={o === chosen} onChange={() => setPicked(o.action)} disabled={busy} />
              <span className="run-hold-option-label">{o.label}</span>
              <span className="run-hold-option-detail">{o.detail}</span>
            </label>
          ))}
        </div>
      )}

      {chosen?.action === 'addBudget' && (
        <div className="run-hold-field">
          <label htmlFor={amountId}>Add to this run’s limit</label>
          <div className="run-hold-amount">
            <span aria-hidden="true">$</span>
            <input
              id={amountId}
              type="number"
              inputMode="decimal"
              min={0}
              max={RUN_ADD_BUDGET_MAX_USD}
              step="0.5"
              value={amount}
              disabled={busy}
              aria-invalid={amountBad || undefined}
              aria-describedby={amountHelpId}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </div>
          <p id={amountHelpId} className="run-hold-help" data-invalid={amountBad || undefined}>
            {amountBad ? `Enter an amount above $0 and up to ${money(RUN_ADD_BUDGET_MAX_USD)}.` : `Up to ${money(RUN_ADD_BUDGET_MAX_USD)}. Your project limits still apply.`}
          </p>
        </div>
      )}

      {chosen?.action === 'skipReview' && (
        <div className="run-hold-field">
          <p className="run-hold-help">The change goes ahead without the review step. Merge review still asks.</p>
          <label htmlFor={noteId}>Note for the orchestrator (optional)</label>
          <input id={noteId} type="text" className="run-hold-note" value={note} maxLength={500} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}

      {hintShown && !sessionOpen && (
        <p className="run-hold-help" role="status">
          Pick a model below, then Continue.
        </p>
      )}

      {error && (
        <p className="run-hold-error pause-error" role="alert">
          {error}
        </p>
      )}

      <div className="run-hold-actions">
        {kind === 'plan-blocked' && (
          <>
            {canAnswer && (
              <Button variant="primary" size="sm" onClick={onAnswer}>
                Answer
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onShowPlan}>
              Show the plan
            </Button>
          </>
        )}
        {kind === 'failed' && canContinue && (
          <Button variant="primary" size="sm" onClick={onAnswer}>
            Continue
          </Button>
        )}
        {chosen && (
          <Button variant={kind === 'plan-blocked' ? 'secondary' : 'primary'} size="sm" disabled={busy || amountBad} onClick={() => run(chosen)}>
            {chosen.button}
          </Button>
        )}
        {kind === 'usage-limit' && summary?.autoResume && (
          <Button size="sm" disabled={busy} onClick={() => void act(() => cancelAutoResume(runId))}>
            Cancel auto-resume
          </Button>
        )}
        {(has('end') || !summary?.hold) && sessionOpen && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => stopRun())}>
            End the run and keep the work
          </Button>
        )}
      </div>
    </section>
    {confirmDialog}
    </>
  )
}
