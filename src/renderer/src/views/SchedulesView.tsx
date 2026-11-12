import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, Plus } from 'lucide-react'
import type { Schedule } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { SCHEDULES_EMPTY_HINT, SCHEDULES_PAUSED_BANNER, SCHEDULE_UNATTENDED_NOTE, resultText, scheduleRows } from '@shared/view/schedules'
import { useAppStore } from '../store/useAppStore'
import AppNavigateBanner from '../components/AppNavigateBanner'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Switch } from '../components/ui/Switch'
import { useConfirm } from '../components/ui/ConfirmDialog'
import ScheduleRow from '../components/schedules/ScheduleRow'
import ScheduleEditor from '../components/schedules/ScheduleEditor'
import { saveSchedulesPaused, useSchedules } from '../components/schedules/useSchedules'
import { cleanIpcError } from '../lib/ipcError'
import { folderName } from '../lib/paths'
import { formatDateTime } from '../lib/dates'
import { scrollWithin } from '../lib/scrollWithin'
import '../styles/schedules.css'

/** The schedulesFocus request already handled; module level so a remount never replays an old request. */
let handledFocusSeq = -1

/**
 * The app-wide Schedules page (docs/design/schedules.md section 5): the list with row actions, the editor, per-row
 * history, the "Pause all schedules" switch with its banner, and the empty state that teaches the chat path. Every
 * IPC call may reject (the error path, also while the runtime half is missing): the page says so and keeps working.
 * Action results go to one polite live region; failures also show as a visible banner.
 */
export default function SchedulesView(): ReactElement {
  const data = useSchedules()
  const projects = useAppStore((s) => s.projects)
  const focus = useAppStore((s) => s.schedulesFocus)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [editor, setEditor] = useState<{ open: boolean; editing: Schedule | null }>({ open: false, editing: null })
  const [failure, setFailure] = useState<string | null>(null)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [live, setLive] = useState('')
  const [historyKeys, setHistoryKeys] = useState<Record<string, number>>({})
  const { confirm, dialog: confirmDialog } = useConfirm()
  const h1Ref = useRef<HTMLHeadingElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Relative next-run times stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // A schedules:changed push reloads the open histories of the schedules it names.
  useEffect(() => {
    if (data.changedSeq === 0) return
    setHistoryKeys((cur) => {
      const next = { ...cur }
      for (const id of data.changedIds) next[id] = (next[id] ?? 0) + 1
      return next
    })
  }, [data.changedSeq, data.changedIds])

  const say = useCallback((text: string) => {
    // Clear first so the same sentence twice is still announced.
    setLive('')
    requestAnimationFrame(() => setLive(text))
  }, [])

  const refs = useMemo(() => projects.filter((p) => !isVirtualProjectId(p.id)).map((p) => ({ id: p.id, name: p.name })), [projects])
  const rows = useMemo(() => (data.list ? scheduleRows(data.list, { now, projects: refs, globalPaused: !!data.paused, folderName }) : []), [data.list, now, refs, data.paused])
  const byId = useMemo(() => new Map((data.list ?? []).map((s) => [s.id, s])), [data.list])

  // Land on the page heading, or on one schedule's row (the run meta's "Scheduled:" label).
  useEffect(() => {
    if (!focus || focus.seq === handledFocusSeq) return
    if (focus.scheduleId && !data.list) return
    handledFocusSeq = focus.seq
    requestAnimationFrame(() => {
      const row = focus.scheduleId ? document.querySelector<HTMLElement>(`[data-testid="schedule-row"][data-schedule-id="${CSS.escape(focus.scheduleId)}"]`) : null
      if (row) {
        scrollWithin(row, 'nearest')
        row.querySelector<HTMLElement>('.schedule-row-name')?.focus({ preventScroll: true })
      } else h1Ref.current?.focus({ preventScroll: true })
    })
  }, [focus, data.list])

  const act = async (id: string, what: () => Promise<string>, failText: string): Promise<void> => {
    setBusy((b) => ({ ...b, [id]: true }))
    setFailure(null)
    try {
      say(await what())
      await data.reload()
    } catch (e) {
      const msg = cleanIpcError(e, failText)
      setFailure(msg)
      say(msg)
    } finally {
      setBusy((b) => {
        const { [id]: _done, ...rest } = b
        return rest
      })
    }
  }

  const runNow = (s: Schedule): void => {
    void act(
      s.id,
      async () => {
        const entry = await window.orgai.schedules.runNow(s.id)
        setHistoryKeys((k) => ({ ...k, [s.id]: (k[s.id] ?? 0) + 1 }))
        return entry?.result === 'started' ? `${s.name}: started a run.` : `${s.name}: ${resultText(entry)}`
      },
      `${s.name} could not run now.`
    )
  }
  const toggle = (s: Schedule, enable: boolean): void => {
    void act(
      s.id,
      async () => {
        await window.orgai.schedules.setEnabled({ id: s.id, enabled: enable })
        return enable ? `${s.name} resumed.` : `${s.name} paused.`
      },
      enable ? `${s.name} could not be resumed.` : `${s.name} could not be paused.`
    )
  }
  const remove = async (s: Schedule): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${s.name}?`,
      body: 'The schedule and its history are deleted. Runs it already started stay in their projects.',
      confirmLabel: 'Delete schedule',
      danger: true,
      confirmTestId: 'schedule-delete-confirm'
    })
    if (!ok) return
    await act(
      s.id,
      async () => {
        await window.orgai.schedules.remove(s.id)
        return `${s.name} deleted.`
      },
      `${s.name} could not be deleted.`
    )
    // The row is gone: keep focus on the page, not on <body>.
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) h1Ref.current?.focus()
    })
  }

  const setPausedAll = async (v: boolean): Promise<void> => {
    const before = !!data.paused
    data.setPausedLocal(v)
    setPauseBusy(true)
    setFailure(null)
    try {
      await saveSchedulesPaused(v)
      say(v ? 'All schedules paused.' : 'Schedules resumed.')
    } catch (e) {
      data.setPausedLocal(before)
      const msg = cleanIpcError(e, 'The setting could not be saved.')
      setFailure(msg)
      say(msg)
    } finally {
      setPauseBusy(false)
    }
  }

  const openNew = (): void => setEditor({ open: true, editing: null })
  const empty = !!data.list && data.list.length === 0

  return (
    <div className="schedules-view" data-testid="schedules-view" aria-busy={data.loading && !data.list}>
      <div className="topbar">
        <h1 ref={h1Ref} tabIndex={-1}>
          Schedules
        </h1>
        <div className="spacer" />
        <div className="schedules-pause-all">
          <Switch checked={!!data.paused} onChange={(v) => void setPausedAll(v)} label="Pause all schedules" disabled={data.paused === null || pauseBusy} testId="schedules-pause-all" />
          <span aria-hidden="true">Pause all</span>
        </div>
        <Button variant="primary" size="sm" icon={Plus} onClick={openNew} testId="schedules-new">
          New schedule
        </Button>
      </div>
      <AppNavigateBanner />
      <div className="schedules-scroll" ref={scrollRef}>
        <div className="schedules-page">
          {data.paused && (
            <Banner tone="warning" title="Schedules are paused" testId="schedules-paused-banner">
              {SCHEDULES_PAUSED_BANNER}
            </Banner>
          )}
          {failure && (
            <Banner tone="danger" onDismiss={() => setFailure(null)} testId="schedules-action-error">
              {failure}
            </Banner>
          )}
          <p className="schedules-intro muted">{SCHEDULE_UNATTENDED_NOTE} Times are in this computer&apos;s time zone.</p>
          {data.error && !data.list ? (
            <EmptyState
              icon={CalendarClock}
              title="Schedules could not be loaded"
              description={data.error}
              testId="schedules-error"
              actions={
                <Button onClick={() => void data.reload()} testId="schedules-retry">
                  Try again
                </Button>
              }
            />
          ) : !data.list ? (
            <p className="muted" data-testid="schedules-loading">
              Loading schedules…
            </p>
          ) : empty ? (
            <EmptyState
              icon={CalendarClock}
              title="No schedules yet"
              description={
                <>
                  A schedule starts a team run or a Chat run at the times you choose. {SCHEDULES_EMPTY_HINT}, or create one here.
                </>
              }
              testId="schedules-empty"
              actions={
                <>
                  <Button variant="primary" icon={Plus} onClick={openNew} testId="schedules-empty-new">
                    New schedule
                  </Button>
                  <Button onClick={() => void useAppStore.getState().openAssistant('quick', { fresh: true })} testId="schedules-empty-chat">
                    Open Chat
                  </Button>
                </>
              }
            />
          ) : (
            <>
              {data.error && (
                <p className="field-error" data-testid="schedules-refresh-error">
                  {data.error} The list may be out of date.
                </p>
              )}
              <ul className="schedules-list" data-testid="schedules-list" aria-label="Schedules">
                {rows.map((row) => {
                  const s = byId.get(row.id) as Schedule
                  return (
                    <ScheduleRow
                      key={row.id}
                      row={row}
                      busy={!!busy[row.id]}
                      historyKey={historyKeys[row.id] ?? 0}
                      onRunNow={() => runNow(s)}
                      onToggle={() => toggle(s, row.toggle === 'Resume')}
                      onEdit={() => setEditor({ open: true, editing: s })}
                      onDelete={() => void remove(s)}
                      onHistoryOpened={() => {
                        // Main clears unread when the history is read; the next list shows it.
                        window.setTimeout(() => void data.reload(), 300)
                      }}
                      announce={say}
                    />
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </div>
      <ScheduleEditor
        open={editor.open}
        editing={editor.editing}
        onClose={() => setEditor({ open: false, editing: null })}
        onSaved={(saved, created) => {
          setEditor({ open: false, editing: null })
          say(`${saved.name} ${created ? 'created' : 'saved'}.${saved.nextRunAt ? ` Next run ${formatDateTime(saved.nextRunAt)}.` : ''}`)
          void data.reload().then(() => useAppStore.getState().openSchedules({ scheduleId: saved.id }))
        }}
      />
      {confirmDialog}
      <p className="sr-only" role="status" aria-live="polite" data-testid="schedules-live">
        {live}
      </p>
    </div>
  )
}
