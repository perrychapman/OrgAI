import type { FormEvent, ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { cleanDisplayName, DISPLAY_NAME_MAX_CHARS } from '@shared/displayName'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Popover } from '../ui/Popover'
import { DashboardLive } from './DashboardLive'
import type { DashboardAnnouncement } from './DashboardContext'
import { useAllSummaries, useBandSnapshot, useDecisionTotal, useNow } from './useDashboardData'
import { useAppStore } from '../../store/useAppStore'
import { clockLabel, pausedRuns, sinceLastSeen, SINCE_WINDOW_MS } from '../../lib/dashboard'
import { bandWorkFacts } from '../../lib/dashboardBand'
import { dashboardBrief, salutation } from '../../lib/dashboardBrief'
import { NAME_NOT_SAVED, NAME_REFUSED, saveDisplayName } from '../../lib/dashboardName'
import { runCostInput, sumCosts } from '../../lib/cost'

/**
 * The greeting `dashboard-hero` (docs/design/dashboard-overhaul.md section 5): the salutation, the brief, the name control,
 * the Customise button and the page's one live region. Props are the contract with DashboardView:
 * - `firstLaunch`: no projects ("Welcome to OrgAI." and its line; "Welcome to OrgAI, Sam." once a name is saved).
 * - `announce`: the message for the page's one live region, rendered here through `DashboardLive`.
 * - `onAnnounce`: speak a message (name saved / removed).
 * - `customise`: the Customise button, owned by DashboardView, placed at the end of the greeting row (absent on first launch).
 * - `lastSeen` / `firstVisit`: from `useLastSeen()` in DashboardView.
 *
 * The person's name is shown only here and in the two edit fields: it never goes into a log, an error string or an
 * announcement.
 */
export interface GreetingProps {
  firstLaunch: boolean
  announce: DashboardAnnouncement | null
  onAnnounce: (text: string) => void
  customise?: ReactNode
  lastSeen: number
  firstVisit: boolean
}

const SAVE_FAILED = `${NAME_NOT_SAVED} Try again.`

/** AppSettings.displayName: read once, then follow settings:changed (another window, the Settings field). */
function useDisplayName(): [string | undefined, (name: string | undefined) => void] {
  const [name, setName] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    window.orgai.settings
      .get()
      .then((s) => alive && setName(cleanDisplayName(s.displayName)))
      .catch(() => undefined)
    const off = window.orgai.onSettingsChanged((s) => setName(cleanDisplayName(s.displayName)))
    return () => {
      alive = false
      off()
    }
  }, [])
  return [name, setName]
}

/** The panel body: a labelled field, a hint, Save (Remove name when emptying an existing name) and Cancel. */
function NameForm({ name, close, onSaved }: { name: string | undefined; close: () => void; onSaved: (saved: string | undefined) => void }): ReactElement {
  const uid = useId()
  const inputId = `${uid}-name`
  const hintId = `${uid}-hint`
  const errorId = `${uid}-error`
  const [draft, setDraft] = useState(name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const removing = !!name && draft.trim() === ''

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    const clean = cleanDisplayName(draft)
    if (draft.trim() !== '' && clean === undefined) {
      setError(NAME_REFUSED)
      return
    }
    // Nothing changed (or nothing to remove): close without saving.
    if (clean === name) {
      close()
      return
    }
    setBusy(true)
    try {
      await saveDisplayName(clean ?? null)
      onSaved(clean)
      close()
    } catch {
      setError(SAVE_FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="dash-name-form" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={inputId} className="dash-name-label">
        Your name
      </label>
      <Input
        id={inputId}
        data-testid="dash-name-input"
        value={draft}
        maxLength={DISPLAY_NAME_MAX_CHARS}
        autoComplete="off"
        spellCheck={false}
        invalid={error !== null}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        onChange={(v) => {
          setDraft(v)
          setError(null)
        }}
      />
      <p className="dash-name-hint" id={hintId}>
        Used for the greeting on the Dashboard. It stays on this computer.
      </p>
      {error && (
        <p className="dash-name-error" id={errorId} role="alert" data-testid="dash-name-error">
          {error}
        </p>
      )}
      <div className="dash-name-actions">
        <Button type="submit" variant="primary" size="sm" inert={busy} testId="dash-name-save">
          {removing ? 'Remove name' : 'Save'}
        </Button>
        <Button variant="secondary" size="sm" onClick={close} testId="dash-name-cancel">
          Cancel
        </Button>
      </div>
    </form>
  )
}

function NameControl({ name, onSaved }: { name: string | undefined; onSaved: (saved: string | undefined) => void }): ReactElement {
  const panel = (api: { close: () => void }): ReactElement => <NameForm name={name} close={api.close} onSaved={onSaved} />
  if (name) {
    return (
      <Popover
        trigger={<Icon icon={Pencil} size="sm" />}
        triggerLabel="Change your name"
        triggerTitle="Change your name"
        triggerClassName="icon-btn size-md"
        triggerTestId="dash-name-edit"
        label="Your name"
        className="dash-name-panel"
        testId="dash-name-panel"
      >
        {panel}
      </Popover>
    )
  }
  return (
    <Popover
      trigger={
        <>
          <Icon icon={Plus} size="sm" />
          Add your name
        </>
      }
      triggerClassName="btn secondary sm"
      triggerTestId="dash-name-add" label="Your name" className="dash-name-panel" testId="dash-name-panel">
      {panel}
    </Popover>
  )
}

export function Greeting({ firstLaunch, announce, onAnnounce, customise, lastSeen, firstVisit }: GreetingProps): ReactElement {
  const now = useNow()
  const summaries = useAllSummaries()
  const snapshot = useBandSnapshot()
  const decisions = useDecisionTotal()
  const projects = useAppStore((s) => s.projects)
  const history = useAppStore((s) => s.historyByProject)
  const [name, setName] = useDisplayName()
  // After a save the control may change (Add becomes Edit and back): focus whichever exists now.
  const [focusSeq, setFocusSeq] = useState(0)

  const ready = projects.every((p) => p.id in history)
  const brief = useMemo(() => {
    // A first visit has nothing to compare with: look back over the same 7 days the sentence names.
    const since = sinceLastSeen(summaries, firstVisit ? now - SINCE_WINDOW_MS : lastSeen, now, { cap: Number.MAX_SAFE_INTEGER }).items
    const ran = since.filter((i) => i.kind === 'finished' || i.kind === 'failed')
    const work = bandWorkFacts(snapshot.runs, snapshot.projects, snapshot.virtualProjects)
    const paused = pausedRuns(summaries)
    const resumes = paused.flatMap((r) => (r.autoResume && typeof r.pausedUntil === 'number' ? [r.pausedUntil] : []))
    const until = resumes.length > 0 ? clockLabel(Math.min(...resumes)) : ''
    return dashboardBrief({
      firstLaunch,
      ready,
      anyRunEver: summaries.length > 0,
      now,
      lastSeen,
      firstVisit,
      finished: ran.filter((i) => i.kind === 'finished').length,
      failed: ran.filter((i) => i.kind === 'failed').length,
      closedWaiting: since.filter((i) => i.kind === 'closed-waiting').length,
      ...(ran.length > 0 ? { cost: sumCosts(ran.map((i) => runCostInput(i.run))) } : {}),
      decisions,
      awaitingReply: work.awaitingReply,
      workingAgents: work.workingAgents,
      workingRuns: work.counts.working,
      paused: paused.length,
      ...(until ? { pausedUntilLabel: until } : {})
    })
  }, [summaries, snapshot, decisions, now, lastSeen, firstVisit, firstLaunch, ready])

  const hour = new Date(now).getHours()
  const text = salutation(hour, name, firstLaunch)

  const saved = useCallback(
    (next: string | undefined): void => {
      setName(next)
      setFocusSeq((n) => n + 1)
      onAnnounce(next ? 'Name saved.' : 'Name removed.')
    },
    [onAnnounce, setName]
  )
  useEffect(() => {
    if (focusSeq === 0) return
    const frame = requestAnimationFrame(() => {
      const testId = name ? 'dash-name-edit' : 'dash-name-add'
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // Only a save moves focus; a later settings:changed must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq])

  return (
    <section className="dash-greeting" data-testid="dashboard-hero" aria-label="Overview">
      <div className="dash-greeting-row">
        <p className="dash-salutation" data-testid="dash-greeting-salutation" title={name ? text : undefined}>
          {text}
        </p>
        {name && <NameControl name={name} onSaved={saved} />}
        {customise && <div className="dash-greeting-end">{customise}</div>}
      </div>
      <p className="dash-brief" data-testid="dash-greeting-brief">
        {brief}
      </p>
      {!name && (
        <div className="dash-name-add-row">
          <NameControl name={name} onSaved={saved} />
        </div>
      )}
      <DashboardLive announce={announce} />
    </section>
  )
}
