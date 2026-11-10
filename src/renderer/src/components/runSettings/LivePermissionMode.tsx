import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PermissionMode, Project, RunSummary } from '@shared/types'
import { Button } from '../ui/Button'
import { pendingDecisionCount, useAppStore } from '../../store/useAppStore'
import { PermissionModeControl } from './PermissionModeControl'
import { modelSessionEnded, modelSwitchBlock, waitForModelBoundary } from '../../lib/liveModelSwitch'
import { cleanIpcError } from '../../lib/ipcError'
import { useConfirm } from '../ui/ConfirmDialog'
import {
  PERMISSION_CONTINUED_ELSEWHERE,
  SESSION_EDITS_SUFFIX,
  livePermissionChoices,
  livePermissionOutcome,
  livePermissionValue,
  modeInForce,
  offersInterruptToChange,
  permissionBaseline,
  retryNeedsConfirm,
  sessionEditsAccepted,
  wideningConfirmOptions
} from '../../lib/runSettings'
import '../../styles/run-settings.css'

interface Note {
  tone: 'ok' | 'saved' | 'refused'
  message: string
  /** The run's status when the note was written; the note goes away when the status moves on. */
  status: RunSummary['status']
  /** The mode that was asked for (retried by "Interrupt and change"). */
  mode: PermissionMode
  /** The baseline the choice (and any confirmation of it) was measured against; a retry asks again when it moved. */
  covered: PermissionMode
  /** The mode in force when the note was written; the note goes away when the mode in force changes (an event). */
  seen: PermissionMode
  /** Offer "Interrupt and change": a refusal while the run is replying, and no interrupt sent yet. */
  canInterrupt: boolean
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

/**
 * The live composer's permission chip (docs/design/ux-review-run-start-pre.md, H2): the run's mode, changed through
 * runs:setPermissionMode. Main owns the state; the returned run goes straight into the store (`onRunChanged`) and the
 * run.permissionMode event (useAppStore) keeps it current afterwards, including a card's accept-edits grant
 * (sessionPermissionMode, shown as "· edits accepted this session"). On an ended or paused run the chip shows the mode the next message uses ("Next message: ").
 *
 * Outcomes are always said twice, as visible text (run-permission-note) and in a polite status region
 * (run-permission-status): applied, saved for the next message, or refused with the reason (the chip keeps its value).
 * A refusal while the run is replying is not a dead end: "Interrupt and change" interrupts once, waits for the idle
 * boundary and retries once. Open decision cards are never touched.
 */
export function LivePermissionMode({ run, project, onRunChanged }: { run: RunSummary; project: Pick<Project, 'permissionMode'>; onRunChanged: (run: RunSummary) => void }): ReactElement | null {
  const choices = livePermissionChoices(run)
  const { mode, next } = livePermissionValue(run, project)
  // An "always allow edits" grant from a card, in force over a narrower mode until the session ends (main-owned).
  const live = !next
  const sessionEdits = sessionEditsAccepted(run)
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // A note belongs to the state it was written in: once the run moves on, "refused while running" is stale.
  useEffect(() => {
    setNote((current) => (current && current.status !== run.status ? null : current))
  }, [run.status])
  useEffect(() => {
    if (!note) setAnnouncement('')
  }, [note])
  // A retry offer also belongs to the mode in force when it was written: a run.permissionMode event that moves it (a
  // project change narrowed the run, a card granted edits) makes the offer stale.
  const inForce = permissionBaseline(run, project)
  useEffect(() => {
    // Only a note that offers a retry goes: an outcome sentence ("now Plan only") stays true when a later event restates it,
    // and the store can show a brief intermediate mode while main broadcasts a change.
    setNote((current) => (current && current.canInterrupt && current.seen !== inForce ? null : current))
  }, [inForce])
  const { confirm, dialog } = useConfirm()
  // "Interrupt and change" cannot work while a decision is open or reports are running (the same guards as the model
  // switch), and it comes back by itself when they are gone: read from the store, not from a snapshot.
  const interruptBlock = useAppStore((s) => {
    const state = s.runs[run.id]
    if (!state) return null
    if (pendingDecisionCount(state) > 0) return 'Answer the open decisions to interrupt and change.'
    if (!modelSessionEnded(state.summary) && Object.values(state.agents).some((a) => a.parentId !== null && !['done', 'error'].includes(a.state))) return 'Wait for the active reports to finish to interrupt and change.'
    return null
  })

  if (choices.length === 0) return null

  const focusChip = (): void => {
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-testid="run-settings"][data-surface="live"] [data-testid="run-permission-change"]`)?.focus())
  }

  const record = (target: PermissionMode, result: Awaited<ReturnType<typeof window.orgai.runs.setPermissionMode>>, tried: boolean, covered: PermissionMode): void => {
    if (!alive.current) return
    if (result.run.id !== run.id) {
      // Main answered for the newest run of the chain: this view is of an older one, so it must not say the mode changed.
      setNote({ tone: 'refused', message: PERMISSION_CONTINUED_ELSEWHERE, status: run.status, mode: target, covered, seen: inForce, canInterrupt: false })
      setAnnouncement(PERMISSION_CONTINUED_ELSEWHERE)
      return
    }
    onRunChanged(result.run)
    const outcome = livePermissionOutcome(result, target)
    setNote({
      tone: outcome.tone,
      message: outcome.message,
      status: result.run.status,
      mode: target,
      covered,
      seen: permissionBaseline(result.run, project),
      canInterrupt: !tried && offersInterruptToChange(outcome, result.run.status)
    })
    setAnnouncement(outcome.message)
  }

  const choose = async (target: PermissionMode): Promise<void> => {
    if (pending) return
    setPending(true)
    setNote(null)
    try {
      // A thrown refusal propagates to PermissionModeControl, which shows it and keeps the popover open.
      // PermissionModeControl already confirmed a widening against `inForce` before calling this.
      record(target, await window.orgai.runs.setPermissionMode({ runId: run.id, mode: target }), false, inForce)
    } finally {
      if (alive.current) setPending(false)
    }
  }

  const interruptAndChange = async (): Promise<void> => {
    if (!note || pending) return
    const target = note.mode
    // The baseline the choice was confirmed (or needed no confirmation) against; asked again when the run's mode moved.
    let covered = note.covered
    const confirmedAgainst = async (summary: RunSummary): Promise<boolean> => {
      const now = permissionBaseline(summary, project)
      if (!retryNeedsConfirm(covered, now, target)) return true
      const accepted = await confirm(wideningConfirmOptions(now, target))
      if (!accepted) {
        if (alive.current) setNote(null)
        return false
      }
      // The baseline can move again while the dialog is open: re-read once and stop rather than send unconfirmed.
      const fresh = await window.orgai.runs.get(run.id).catch(() => null)
      if (!fresh || retryNeedsConfirm(now, permissionBaseline(fresh.summary, project), target)) {
        stop('The permission mode in force changed. Choose the mode again.')
        return false
      }
      covered = now
      return true
    }
    const stop = (message: string): void => {
      if (!alive.current) return
      setNote({ tone: 'refused', message, status: run.status, mode: target, covered, seen: inForce, canInterrupt: false })
      setAnnouncement(message)
    }
    setPending(true)
    let interrupted = false
    try {
      // Same guard as the model switch: an interrupt can also stop reports, and open decisions must be answered first.
      const [current, cards] = await Promise.all([window.orgai.runs.get(run.id), window.orgai.runs.pendingCards(run.id)])
      const blocked = current ? modelSwitchBlock(current, cards) : 'This conversation is no longer available.'
      if (blocked) {
        const message = blocked.replace('changing models', 'interrupting')
        setNote({ ...note, tone: 'refused', message })
        setAnnouncement(message)
        return
      }
      // Before anything is interrupted: the run's mode may have moved since the choice was made (a project change
      // narrowed it), which can turn the retry into a widening nobody confirmed.
      if (current && !(await confirmedAgainst(current.summary))) return
      interrupted = true
      await window.orgai.runs.interrupt(run.id)
      try {
        await waitForModelBoundary(() => window.orgai.runs.get(run.id), false, pause)
      } catch (e) {
        // The session ending is also a boundary: the change is then saved for the next message.
        const after = await window.orgai.runs.get(run.id).catch(() => null)
        if (!after || !modelSessionEnded(after.summary)) throw e
      }
      // The mode can also move while waiting for the boundary: check once more against what is in force now.
      const settled = await window.orgai.runs.get(run.id).catch(() => null)
      if (!settled) {
        stop('The permission mode was not changed. The conversation could not be read.')
        return
      }
      if (!(await confirmedAgainst(settled.summary))) return
      record(target, await window.orgai.runs.setPermissionMode({ runId: run.id, mode: target }), true, covered)
    } catch (e) {
      if (!alive.current) return
      const message = cleanIpcError(e, 'The permission mode was not changed.')
      setNote({ tone: 'refused', message, status: run.status, mode: target, covered, seen: inForce, canInterrupt: !interrupted })
      setAnnouncement(message)
    } finally {
      if (alive.current) setPending(false)
      focusChip()
    }
  }

  return (
    <>
      <PermissionModeControl
        value={mode}
        baseline={inForce}
        inForce={live && sessionEdits ? modeInForce(run, mode) : undefined}
        valueSuffix={live && sessionEdits && mode !== 'acceptEdits' ? SESSION_EDITS_SUFFIX : undefined}
        choices={choices}
        isDefault={!run.permissionModeChosen}
        defaultMode={project.permissionMode}
        // "Next message:" marks a pending choice of the user; an untouched chip on an ended run just shows its mode.
        prefix={next && run.permissionModeChosen ? 'Next message: ' : ''}
        showState={false}
        disabled={pending}
        busy={pending}
        onChoose={choose}
        footer={
          <p className="run-popover-help">
            {next ? 'Applies from your next message.' : 'Applies to this run only. Running reports keep the earlier mode until they finish.'} Open approval cards stay open.
          </p>
        }
      />
      {note && (
        <div className={`run-settings-note run-permission-note${note.tone === 'refused' ? ' run-settings-note--warn' : ''}`} data-testid="run-permission-note" data-tone={note.tone}>
          <span>{note.message}</span>
          {note.canInterrupt && interruptBlock && <span data-testid="run-permission-interrupt-blocked">{interruptBlock}</span>}
          {note.canInterrupt && !interruptBlock && (
            <Button
              size="sm"
              testId="run-permission-interrupt"
              loading={pending}
              onClick={() => void interruptAndChange()}
              title="Interrupts the current reply, then changes the mode once the lead is idle."
            >
              Interrupt and change
            </Button>
          )}
        </div>
      )}
      <span className="sr-only" role="status" data-testid="run-permission-status">
        {announcement}
      </span>
      {dialog}
    </>
  )
}
