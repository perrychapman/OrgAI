import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UpdateState } from '@shared/types'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { SettingsCard } from '../settings/SettingsCard'
import { SettingsSection } from '../settings/SettingsSection'
import { scrollWithin } from '../../lib/scrollWithin'
import {
  activeRunsConfirmBody,
  capabilityNote,
  lastCheckedLine,
  progressBytes,
  progressPercent,
  refusalSentence,
  updateAction,
  updateAnnouncement,
  updateStatusLine
} from '../../lib/updates'
import { checkForUpdates, downloadUpdate, ensureUpdates, installUpdate, openReleasePage, useUpdatesStore } from '../../store/updatesStore'
import '../../styles/updates.css'

/** DOM id of the Updates section (the menu's Check for Updates… lands here). */
export const UPDATES_SECTION_ID = 'appsettings-section-updates'
const TITLE_ID = 'appsettings-updates-title'

const FAILED = 'Could not reach the updater. Try again.'
const RELEASE_OPENED = 'Opened the release page in your browser.'
/** A request from the menu or the notice older than this is stale (the About pane never rendered the block). */
const FOCUS_REQUEST_TTL_MS = 5000

/**
 * App settings > About > Updates (docs/agent-notes/updates.md "Renderer"): the version, one status line, one primary
 * action that follows the state, download progress with a text equivalent, untrusted release notes as plain text in a
 * bounded scroller, and the automatic-check switch. Status changes speak through this block's one polite region.
 */
export function UpdatesSection({ autoCheck, onAutoCheckChange }: { autoCheck: boolean; onAutoCheckChange: (on: boolean) => void }): ReactElement {
  useEffect(ensureUpdates, [])
  const state = useUpdatesStore((s) => s.state)
  const focusRequest = useUpdatesStore((s) => s.focusRequest)
  const [feedback, setFeedback] = useState('')
  const [announce, setAnnounce] = useState('')
  const { confirm, dialog } = useConfirm()
  const sectionRef = useRef<HTMLElement>(null)
  const prev = useRef<UpdateState | null>(null)
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The secondary release-page button had focus: when it goes away, focus moves to the primary action. */
  const releaseFocused = useRef(false)

  // One polite announcement per meaningful change (never per progress step).
  useEffect(() => {
    if (!state) return
    const before = prev.current
    const said = before ? updateAnnouncement(before, state) : ''
    prev.current = state
    // A sentence about an earlier step no longer describes the action.
    if (before && (before.status !== state.status || !!before.installing !== !!state.installing)) setFeedback('')
    if (said) speak(said)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // The menu's Check for Updates…: after App settings landed on the About pane heading, move on to this section.
  useEffect(() => {
    if (focusRequest === 0) return
    if (Date.now() - focusRequest > FOCUS_REQUEST_TTL_MS) {
      useUpdatesStore.getState().clearFocusRequest()
      return
    }
    const land = (): void => {
      scrollWithin(sectionRef.current, 'start')
      const title = document.getElementById(TITLE_ID)
      title?.setAttribute('tabindex', '-1')
      title?.focus({ preventScroll: true })
      useUpdatesStore.getState().clearFocusRequest()
    }
    const t = setTimeout(land, 60)
    return () => clearTimeout(t)
  }, [focusRequest])

  /** Clear first, then set on the next tick, so the same sentence twice is read twice. */
  function speak(text: string): void {
    if (speakTimer.current) clearTimeout(speakTimer.current)
    setAnnounce('')
    speakTimer.current = setTimeout(() => setAnnounce(text), 60)
  }
  useEffect(() => () => {
    if (speakTimer.current) clearTimeout(speakTimer.current)
  }, [])

  const say = (text: string): void => {
    setFeedback(text)
    if (text) speak(text)
  }

  const runAction = async (): Promise<void> => {
    if (!state) return
    const action = updateAction(state)
    if (action.busy || action.kind === 'none') return
    setFeedback('')
    try {
      if (action.kind === 'check') await checkForUpdates()
      else if (action.kind === 'open-release') {
        await openReleasePage()
        say(RELEASE_OPENED)
      } else if (action.kind === 'download') say(refusalSentence(await downloadUpdate()))
      else if (action.kind === 'install') {
        // force only after the user confirmed at least as many live runs as main now counts: a run started while the
        // dialog was open (a schedule, another window) asks again with the new count.
        let res = await installUpdate()
        let confirmed = -1
        while (!res.ok && res.reason === 'active-runs') {
          const n = res.activeRuns ?? 0
          if (n <= confirmed) {
            res = await installUpdate(true)
            break
          }
          const ok = await confirm({
            title: 'Stop runs and install the update?',
            body: activeRunsConfirmBody(res.activeRuns),
            confirmLabel: 'Stop runs and install',
            cancelLabel: 'Not now',
            danger: true,
            confirmTestId: 'updates-install-confirm'
          })
          if (!ok) return say('Not installed now. The update installs the next time OrgAI quits, or restart and install later.')
          confirmed = n
          res = await installUpdate()
        }
        say(refusalSentence(res))
      }
    } catch (err) {
      console.warn('updates: action failed', action.kind, err)
      say(FAILED)
    }
  }

  const releasePage = async (): Promise<void> => {
    try {
      await openReleasePage()
      say(RELEASE_OPENED)
    } catch {
      say(FAILED)
    }
  }

  const action = state ? updateAction(state) : null
  const downloading = state?.status === 'downloading'
  const percent = progressPercent(state?.progress)
  const bytes = progressBytes(state?.progress)
  const checked = state ? lastCheckedLine(state) : ''
  const note = state && state.capability === 'manual' ? capabilityNote(state.reason) : ''
  // Notes only for a newer version that is still pending (never after an install started).
  const notes = state?.availableVersion && state.releaseNotes && !state.installing && state.status !== 'up-to-date' ? state.releaseNotes : ''
  // The release page as a second action when the primary one is something else and a version is known.
  const showReleaseLink = !!state && state.capability === 'auto' && !!state.availableVersion && !state.installing && state.status !== 'up-to-date'
  // It went away while focused (install started, a newer check): continue from the primary action, never <body>.
  useEffect(() => {
    if (showReleaseLink || !releaseFocused.current) return
    releaseFocused.current = false
    const a = document.activeElement
    if (a && a !== document.body) return
    document.querySelector<HTMLElement>('[data-testid=updates-action]')?.focus()
  }, [showReleaseLink])

  return (
    <SettingsSection id={UPDATES_SECTION_ID} title="Updates" titleId={TITLE_ID} testId="updates-block" sectionRef={sectionRef}>
      <SettingsCard>
        <div className="updates-body">
          <dl className="about-list">
            <dt>Installed version</dt>
            <dd data-testid="updates-current">{state?.currentVersion ?? '…'}</dd>
          </dl>
          <div className="updates-status">
            <p className="updates-line" data-testid="updates-status" data-status={state?.status} data-capability={state?.capability}>
              {state ? updateStatusLine(state) : 'Loading…'}
            </p>
            {note && (
              <p className="updates-note muted" data-testid="updates-capability">
                {note}
              </p>
            )}
            {checked && (
              <p className="updates-checked muted" data-testid="updates-checked">
                {checked}
              </p>
            )}
          </div>
          {downloading && (
            <div className="updates-progress" data-testid="updates-progress">
              <progress className="updates-bar" max={100} value={percent} aria-label="Download progress" aria-valuetext={`${percent}%${bytes ? `, ${bytes}` : ''}`} />
              <span className="updates-progress-text muted" aria-hidden="true">
                {percent}%{bytes ? ` · ${bytes}` : ''}
              </span>
            </div>
          )}
          {action && action.kind !== 'none' && (
            <div className="updates-actions">
              <Button
                variant="primary"
                testId="updates-action"
                inert={action.busy}
                ariaDescribedBy={feedback ? 'updates-feedback' : undefined}
                onClick={() => void runAction()}
              >
                {action.label}
              </Button>
              {showReleaseLink && (
                <span
                  className="updates-secondary"
                  onFocus={() => (releaseFocused.current = true)}
                  // A blur from removal has no relatedTarget; only a real move elsewhere clears the flag.
                  onBlur={(e) => {
                    if (e.relatedTarget) releaseFocused.current = false
                  }}
                >
                  <Button variant="ghost" testId="updates-release-page" onClick={() => void releasePage()}>
                    Open release page
                  </Button>
                </span>
              )}
            </div>
          )}
          {feedback && (
            <p id="updates-feedback" className="updates-feedback" data-testid="updates-feedback">
              {feedback}
            </p>
          )}
          {notes && (
            <div className="updates-notes-block">
              <h4 className="settings-group-title" id="updates-notes-title">
                What&apos;s new in {state?.availableVersion}
              </h4>
              {/* Untrusted text from the feed: a text node only (never HTML, Markdown or links). Focusable so it scrolls by keyboard. */}
              <div className="updates-notes" role="region" aria-labelledby="updates-notes-title" tabIndex={0} data-testid="updates-notes">
                {notes}
              </div>
            </div>
          )}
        </div>
        <SettingRow
          id="auto-update-check-row"
          title="Check for updates automatically"
          description={
            state?.capability === 'none'
              ? 'Has no effect in this build.'
              : 'Checks about 30 seconds after launch, then every six hours. Nothing downloads until you choose to. A downloaded update installs when you restart from here or when OrgAI next quits.'
          }
          control={
            <Switch
              checked={autoCheck}
              label="Check for updates automatically"
              testId="auto-update-check-switch"
              describedBy={settingDescId('auto-update-check-row')}
              onChange={onAutoCheckChange}
            />
          }
        />
      </SettingsCard>
      <span className="sr-only" role="status" aria-live="polite" data-testid="updates-announce">
        {announce}
      </span>
      {dialog}
    </SettingsSection>
  )
}
