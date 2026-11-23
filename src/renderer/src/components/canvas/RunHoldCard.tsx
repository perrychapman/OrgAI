import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { holdOf, type HoldExtras, type HoldKind } from '../../lib/runHold'
import '../../styles/run-hold.css'

/** Runtime actions for the kinds that do not come from the summary today; each is offered only when given. */
export interface RunHoldActions {
  /** Budget: raise the limit and continue. */
  addBudget?: () => Promise<void>
  /** Provider: try the same provider again. */
  retry?: () => Promise<void>
  /** Provider: pick another provider. */
  switchProvider?: () => Promise<void> | void
  /** Agent failed: run it again on a stronger model. */
  retryStronger?: () => Promise<void>
  /** Agent failed: skip the review step. */
  skip?: () => Promise<void>
}

export interface RunHoldCardProps {
  runId: string
  canContinue: boolean
  sessionOpen: boolean
  /** Focuses the composer (plan-blocked Answer, failed Continue). */
  onAnswer: () => void
  /** Opens the plan side tab. */
  onShowPlan: () => void
  /** Focuses the composer's model switch; the button shows only when given. */
  onSwitchModel?: () => void
  /** Data for the runtime holds (budget, provider, agent-failed). */
  extras?: Omit<HoldExtras, 'now' | 'sessionOpen'>
  actions?: RunHoldActions
}

interface Option {
  id: string
  label: string
  detail: string
  run: () => Promise<void> | void
}

/** The radio options of a runtime hold: only the ones whose action exists. */
function optionsFor(kind: HoldKind, a: RunHoldActions): Option[] {
  const out: Option[] = []
  if (kind === 'budget' && a.addBudget) out.push({ id: 'budget', label: 'Add budget and continue', detail: 'Raises this run’s limit and picks up where it stopped.', run: a.addBudget })
  if (kind === 'provider') {
    if (a.retry) out.push({ id: 'retry', label: 'Try again', detail: 'Same provider, same model.', run: a.retry })
    if (a.switchProvider) out.push({ id: 'switch', label: 'Use another provider', detail: 'Choose a different connection for the next try.', run: a.switchProvider })
  }
  if (kind === 'agent-failed') {
    if (a.retryStronger) out.push({ id: 'stronger', label: 'Retry on a stronger model', detail: 'Runs this agent again with a more capable model.', run: a.retryStronger })
    if (a.skip) out.push({ id: 'skip', label: 'Skip this step', detail: 'Carries on without it. You can ask for it again later.', run: a.skip })
  }
  return out
}

/** The card that says what stopped a run and what the user can do about it. Renders nothing when nothing holds the run. */
export function RunHoldCard({ runId, canContinue, sessionOpen, onAnswer, onShowPlan, onSwitchModel, extras, actions = {} }: RunHoldCardProps): ReactElement | null {
  const summary = useAppStore((s) => s.runs[runId]?.summary)
  const plan = useAppStore((s) => s.runs[runId]?.plan)
  const resumeNow = useAppStore((s) => s.resumeNow)
  const cancelAutoResume = useAppStore((s) => s.cancelAutoResume)
  const stopRun = useAppStore((s) => s.stopRun)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const titleId = useId()
  const groupId = useId()

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const hold = holdOf(summary, plan, { ...extras, now, sessionOpen })
  if (!hold) return null

  const act = async (fn: () => Promise<void> | void): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const options = optionsFor(hold.kind, actions)
  const choose = options.length > 1
  const chosen = options.find((o) => o.id === picked) ?? options[0]
  const canAnswer = sessionOpen || canContinue
  const rootClass = hold.kind === 'usage-limit' ? 'run-hold pause-banner' : hold.kind === 'plan-blocked' ? 'run-hold pause-banner plan-blocked-banner' : 'run-hold'

  return (
    <section className={rootClass} aria-labelledby={titleId} data-testid={hold.kind === 'failed' ? 'run-error' : undefined} data-hold={hold.kind} data-tone={hold.tone}>
      <div className="run-hold-head">
        <span className="run-hold-pill" data-tone={hold.tone}>
          <span className={hold.tone === 'failed' ? 'run-hold-dot' : hold.tone === 'retrying' ? 'run-hold-dot motion-pulse' : 'run-hold-dot motion-breathe'} aria-hidden="true" />
          {hold.word}
        </span>
        <span className="run-hold-safe">{hold.safe}</span>
      </div>
      <h2 id={titleId} className="run-hold-title">
        {hold.title}
      </h2>
      <p className="run-hold-text">{hold.text}</p>

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
        <div role="radiogroup" aria-label="What to do next" className="run-hold-options">
          {options.map((o) => (
            <label key={o.id} className="run-hold-option" data-checked={o === chosen ? 'true' : undefined}>
              <input type="radio" name={groupId} value={o.id} checked={o === chosen} onChange={() => setPicked(o.id)} disabled={busy} />
              <span className="run-hold-option-label">{o.label}</span>
              <span className="run-hold-option-detail">{o.detail}</span>
            </label>
          ))}
        </div>
      )}

      {error && (
        <p className="run-hold-error pause-error" role="status">
          {error}
        </p>
      )}

      <div className="run-hold-actions">
        {hold.kind === 'usage-limit' && (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(() => resumeNow(runId))}>
              Resume now
            </Button>
            {summary?.autoResume && (
              <Button size="sm" disabled={busy} onClick={() => void act(() => cancelAutoResume(runId))}>
                Cancel auto-resume
              </Button>
            )}
            {onSwitchModel && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={onSwitchModel}>
                Switch model
              </Button>
            )}
          </>
        )}
        {hold.kind === 'plan-blocked' && (
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
        {hold.kind === 'failed' && canContinue && (
          <Button variant="primary" size="sm" onClick={onAnswer}>
            Continue
          </Button>
        )}
        {choose && chosen && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(chosen.run)}>
            {chosen.label}
          </Button>
        )}
        {!choose &&
          options.map((o, i) => (
            <Button key={o.id} variant={i === 0 ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={() => void act(o.run)}>
              {o.label}
            </Button>
          ))}
        {sessionOpen && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => stopRun())}>
            End the run and keep the work
          </Button>
        )}
      </div>
    </section>
  )
}
