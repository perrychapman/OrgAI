import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PermissionMode, Project, RunSummary } from '@shared/types'
import { Button } from '../ui/Button'
import { PermissionModeControl } from './PermissionModeControl'
import { modelSessionEnded, modelSwitchBlock, waitForModelBoundary } from '../../lib/liveModelSwitch'
import { cleanIpcError } from '../../lib/ipcError'
import { livePermissionChoices, livePermissionOutcome, livePermissionValue, offersInterruptToChange } from '../../lib/runSettings'
import '../../styles/run-settings.css'

interface Note {
  tone: 'ok' | 'saved' | 'refused'
  message: string
  /** The run's status when the note was written; the note goes away when the status moves on. */
  status: RunSummary['status']
  /** The mode that was asked for (retried by "Interrupt and change"). */
  mode: PermissionMode
  /** Offer "Interrupt and change": a refusal while the run is replying, and no interrupt sent yet. */
  canInterrupt: boolean
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

/**
 * The live composer's permission chip (docs/design/ux-review-run-start-pre.md, H2): the run's mode, changed through
 * runs:setPermissionMode. Main owns the state and emits no event, so the returned run goes straight into the store
 * (`onRunChanged`). On an ended or paused run the chip shows the mode the next message uses ("Next message: ").
 *
 * Outcomes are always said twice, as visible text (run-permission-note) and in a polite status region
 * (run-permission-status): applied, saved for the next message, or refused with the reason (the chip keeps its value).
 * A refusal while the run is replying is not a dead end: "Interrupt and change" interrupts once, waits for the idle
 * boundary and retries once. Open decision cards are never touched.
 */
export function LivePermissionMode({ run, project, onRunChanged }: { run: RunSummary; project: Pick<Project, 'permissionMode'>; onRunChanged: (run: RunSummary) => void }): ReactElement | null {
  const choices = livePermissionChoices(run)
  const { mode, next } = livePermissionValue(run, project)
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

  if (choices.length === 0) return null

  const focusChip = (): void => {
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-testid="run-settings"][data-surface="live"] [data-testid="run-permission-change"]`)?.focus())
  }

  const record = (target: PermissionMode, result: Awaited<ReturnType<typeof window.orgai.runs.setPermissionMode>>, tried: boolean): void => {
    if (!alive.current) return
    if (result.run.id === run.id) onRunChanged(result.run)
    const outcome = livePermissionOutcome(result, target)
    setNote({ tone: outcome.tone, message: outcome.message, status: result.run.status, mode: target, canInterrupt: !tried && offersInterruptToChange(outcome, result.run.status) })
    setAnnouncement(outcome.message)
  }

  const choose = async (target: PermissionMode): Promise<void> => {
    if (pending) return
    setPending(true)
    setNote(null)
    try {
      // A thrown refusal propagates to PermissionModeControl, which shows it and keeps the popover open.
      record(target, await window.orgai.runs.setPermissionMode({ runId: run.id, mode: target }), false)
    } finally {
      if (alive.current) setPending(false)
    }
  }

  const interruptAndChange = async (): Promise<void> => {
    if (!note || pending) return
    const target = note.mode
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
      interrupted = true
      await window.orgai.runs.interrupt(run.id)
      try {
        await waitForModelBoundary(() => window.orgai.runs.get(run.id), false, pause)
      } catch (e) {
        // The session ending is also a boundary: the change is then saved for the next message.
        const after = await window.orgai.runs.get(run.id).catch(() => null)
        if (!after || !modelSessionEnded(after.summary)) throw e
      }
      record(target, await window.orgai.runs.setPermissionMode({ runId: run.id, mode: target }), true)
    } catch (e) {
      if (!alive.current) return
      const message = cleanIpcError(e, 'The permission mode was not changed.')
      setNote({ tone: 'refused', message, status: run.status, mode: target, canInterrupt: !interrupted })
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
        baseline={mode}
        choices={choices}
        isDefault={!run.permissionModeChosen}
        defaultMode={project.permissionMode}
        prefix={next ? 'Next message: ' : ''}
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
          {note.canInterrupt && (
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
    </>
  )
}
