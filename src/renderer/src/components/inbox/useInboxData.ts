import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { projectKindOf } from '@shared/defaults'
import { useAppStore, waitingRuns } from '../../store/useAppStore'
import { useAllSummaries, useLiveRuns } from '../dashboard/useDashboardData'
import { useTeamAttentionItems } from '../../lib/menuActions'
import { decisionLocationLabel } from '../../lib/chatPermissions'
import { displayRunName } from '../../lib/orgChange'
import {
  INBOX_READ_CAP,
  buildFinished,
  buildWaiting,
  readReadIds,
  readSeenAt,
  writeReadIds,
  writeSeenAt,
  type InboxFinishedIn,
  type InboxItem
} from '../../lib/inbox'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Everything the Inbox lists. The waiting items come from the same sources the sidebar badge counts (`waitingRuns`
 * through `waitingItems`, plus the team-files items), so the number is the same everywhere. Finished items are runs that
 * ended after the user's last "mark all read" (renderer-only, localStorage) and that the user has not opened or cleared.
 */
export function useInboxData(now: number): {
  waiting: InboxItem[]
  finished: InboxItem[]
  /** Distinct projects with a run that is working right now. */
  workingTeams: number
  markRead: (runId: string) => void
  markAllRead: () => void
} {
  const runs = useAppStore(useShallow(waitingRuns))
  const teamItems = useTeamAttentionItems()
  const projects = useAppStore((s) => s.projects)
  const summaries = useAllSummaries()
  const live = useLiveRuns()
  const [seen, setSeen] = useState<{ seenAt: number; read: string[] }>(() => {
    const store = storage()
    let seenAt = readSeenAt(store)
    // First visit: nothing earlier counts as news.
    if (seenAt === null) {
      seenAt = Date.now()
      writeSeenAt(store, seenAt)
    }
    return { seenAt, read: readReadIds(store) }
  })

  const waiting = useMemo(
    () =>
      buildWaiting({
        runs,
        teamItems,
        projectName: (r) => decisionLocationLabel(r.summary as Parameters<typeof decisionLocationLabel>[0], projects),
        projectKind: (id) => projectKindOf(projects.find((p) => p.id === id))
      }),
    [runs, teamItems, projects]
  )

  const read = useMemo(() => new Set(seen.read), [seen.read])
  const finished = useMemo(
    () =>
      buildFinished<InboxFinishedIn & (typeof summaries)[number]>({
        summaries,
        seenAt: seen.seenAt,
        read,
        now,
        projectName: (s) => decisionLocationLabel(s, projects),
        runName: (s) => displayRunName(s)
      }),
    [summaries, seen.seenAt, read, now, projects]
  )

  const workingTeams = useMemo(() => new Set(live.filter((r) => r.summary.status === 'running' || r.summary.status === 'starting').map((r) => r.summary.projectId)).size, [live])

  const markRead = useCallback((runId: string) => {
    setSeen((cur) => {
      if (cur.read.includes(runId)) return cur
      const read = [...cur.read, runId].slice(-INBOX_READ_CAP)
      writeReadIds(storage(), read)
      return { ...cur, read }
    })
  }, [])
  const markAllRead = useCallback(() => {
    const at = Date.now()
    writeSeenAt(storage(), at)
    writeReadIds(storage(), [])
    setSeen({ seenAt: at, read: [] })
  }, [])

  return { waiting, finished, workingTeams, markRead, markAllRead }
}
