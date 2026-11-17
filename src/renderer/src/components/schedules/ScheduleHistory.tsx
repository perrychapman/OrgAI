import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { settleRunFocus } from '../outputs/OutputDetail'
import type { ScheduleHistoryEntry } from '@shared/types'
import { historyRow, resultWhy, resultWord, sortHistory } from '@shared/view/schedules'
import { cleanIpcError } from '../../lib/ipcError'
import { useAppStore } from '../../store/useAppStore'
import { Cost } from '../ui/Cost'
import { Badge } from '../ui/Badge'

/** Open the run a history entry started, through the existing open-run path (focusRun, then the run view). */
async function openScheduledRun(runId: string, projectId: string | undefined): Promise<boolean> {
  let pid = projectId
  if (!pid) {
    const record = await window.orgai.runs.get(runId).catch(() => null)
    pid = record?.summary.projectId
  }
  if (!pid) return false
  const st = useAppStore.getState()
  await st.focusRun(pid, runId)
  const after = useAppStore.getState()
  if (!after.runs[runId]) return false
  after.setView('run')
  return true
}

/**
 * One schedule's history, newest first (docs/design/schedules.md section 5). Loading it clears the schedule's unread
 * count (schedules:history does that in main). Reloads when `reloadKey` changes (a schedules:changed push for it).
 */
export default function ScheduleHistory({
  scheduleId,
  scheduleName,
  reloadKey,
  announce,
  onLoaded
}: {
  scheduleId: string
  scheduleName: string
  reloadKey: number
  announce: (text: string) => void
  /** The history was read (main has cleared the unread count): the page reloads its list. */
  onLoaded: () => void
}): ReactElement {
  const [entries, setEntries] = useState<ScheduleHistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const loaded = useRef(onLoaded)
  loaded.current = onLoaded

  useEffect(() => {
    let live = true
    window.orgai.schedules.history(scheduleId).then(
      (list) => {
        if (!live) return
        setEntries(sortHistory(Array.isArray(list) ? list : []))
        setError(null)
        loaded.current()
      },
      (e) => {
        if (live) setError(cleanIpcError(e, 'The history could not be loaded.'))
      }
    )
    return () => {
      live = false
    }
  }, [scheduleId, reloadKey])

  if (error) {
    return (
      <p className="field-error schedule-history-note" data-testid="schedule-history-error">
        {error}
      </p>
    )
  }
  if (!entries) return <p className="muted schedule-history-note">Loading history…</p>
  if (entries.length === 0) {
    return (
      <p className="muted schedule-history-note" data-testid="schedule-history-empty">
        Nothing has run yet.
      </p>
    )
  }
  return (
    <>
      {openError && (
        <p className="field-error schedule-history-note" data-testid="schedule-history-open-error">
          {openError}
        </p>
      )}
      <table className="schedule-history" data-testid="schedule-history">
        <caption className="sr-only">History of {scheduleName}, newest first</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Trigger</th>
            <th scope="col">Result</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="num">
              Cost
            </th>
            <th scope="col">
              <span className="sr-only">Run</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const row = historyRow(e)
            return (
              <tr key={row.id} data-testid="schedule-history-row" data-result={e.result} data-reason={e.reason}>
                <td title={row.whenTitle}>{row.when}</td>
                <td>{row.trigger}</td>
                <td className="schedule-history-result">
                  <Badge tone={row.tone === 'danger' ? 'danger' : row.tone === 'warning' ? 'warning' : row.tone === 'success' ? 'success' : 'neutral'}>
                    {resultWord(e.result)}
                  </Badge>
                  {e.result !== 'started' && <span className="schedule-history-why">{resultWhy(e)}</span>}
                </td>
                <td>{row.outcome || <span className="muted">—</span>}</td>
                <td className="num">{row.cost ? <Cost value={row.cost} /> : <span className="muted" title="Not ended yet, or no run">—</span>}</td>
                <td>
                  {row.runId && (
                    <button
                      type="button"
                      className="link-btn"
                      data-testid="schedule-history-open"
                      onClick={() => {
                        setOpenError(null)
                        const fail = (): void => {
                          const msg = 'That run could not be opened. It may have been deleted.'
                          setOpenError(msg)
                          announce(msg)
                        }
                        openScheduledRun(row.runId as string, row.projectId).then((ok) => (ok ? settleRunFocus() : fail()), fail)
                      }}
                    >
                      Open run<span className="sr-only"> from {row.when}</span>
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </>
  )
}
