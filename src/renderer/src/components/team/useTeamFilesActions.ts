import { useCallback, useRef, useState } from 'react'
import type { TeamFilesActionResult, TeamFilesStatus } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { TEAM_FILES_STALE_TEXT, cardVisible, isStaleDecision, statusKey } from '../../lib/teamFiles'

export type TeamFilesBusy = 'commit' | 'enable' | 'approve' | 'reject' | 'undo' | null

interface Keyed {
  text: string
  /** `statusKey` of the status the action left behind: the text is shown only while the status still has this key. */
  key: string
}

/**
 * The Team tab's actions on a project's team files. Every result goes to the store (status and, for approve, reject,
 * undo and enable, the saved project). `message` is the last outcome in words (the status line says it, polite) and
 * `error` is a failure the card shows next to its buttons; both belong to the status they came from and disappear when
 * it changes (new files, another state), so they never sit beside a state they do not describe.
 */
export function useTeamFilesActions(projectId: string): {
  busy: TeamFilesBusy
  message: string | null
  error: string | null
  commit: () => Promise<void>
  enable: () => Promise<void>
  approve: (digest: string) => Promise<boolean>
  reject: (digest: string) => Promise<boolean>
  undo: () => Promise<void>
} {
  const [busy, setBusy] = useState<TeamFilesBusy>(null)
  const [msg, setMsg] = useState<Keyed | null>(null)
  const [err, setErr] = useState<Keyed | null>(null)
  const status = useAppStore((s) => s.teamFilesByProject[projectId])
  const inFlight = useRef(false)
  const nowKey = useCallback((): string => statusKey(useAppStore.getState().teamFilesByProject[projectId]), [projectId])
  const say = useCallback((text: string | null): void => setMsg(text ? { text, key: nowKey() } : null), [nowKey])
  const fail = useCallback((text: string): void => setErr({ text, key: nowKey() }), [nowKey])

  const takeResult = useCallback((r: TeamFilesActionResult): TeamFilesStatus => {
    const st = useAppStore.getState()
    st.replaceProject(r.project)
    st.setTeamFilesStatus(r.status)
    return r.status
  }, [])

  const run = useCallback(async (kind: Exclude<TeamFilesBusy, null>, fn: () => Promise<boolean | void>): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(kind)
    setErr(null)
    try {
      return (await fn()) !== false
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }, [])

  const commit = useCallback(async (): Promise<void> => {
    await run('commit', async () => {
      try {
        const r = await window.orgai.teamFiles.commit({ projectId })
        useAppStore.getState().setTeamFilesStatus(r.status)
        say(r.ok ? r.message || 'Committed the team files.' : r.message || 'The team files could not be committed.')
      } catch (e) {
        say(cleanIpcError(e, 'The team files could not be committed.'))
      }
    })
  }, [projectId, run, say])

  const enable = useCallback(async (): Promise<void> => {
    await run('enable', async () => {
      try {
        takeResult(await window.orgai.teamFiles.enable({ projectId }))
        say('Team files are on again. They were written from the current team.')
      } catch (e) {
        say(cleanIpcError(e, 'Team files could not be turned on.'))
      }
    })
  }, [projectId, run, say, takeResult])

  const decide = useCallback(
    async (kind: 'approve' | 'reject', digest: string): Promise<boolean> =>
      run(kind, async () => {
        try {
          const call = kind === 'approve' ? window.orgai.teamFiles.approve : window.orgai.teamFiles.reject
          takeResult(await call({ projectId, digest }))
          // A rejection is the status line's own sentence ("differ from the team in use ... You rejected them"): saying it
          // twice made screen readers read it twice.
          say(kind === 'approve' ? 'Approved. The team in use now matches the files.' : null)
          return true
        } catch (e) {
          if (isStaleDecision(e)) {
            await useAppStore.getState().refreshTeamFiles(projectId)
            // One voice: the card's alert when the card survived the re-fetch, else the status line.
            if (cardVisible(useAppStore.getState().teamFilesByProject[projectId])) fail(TEAM_FILES_STALE_TEXT)
            else say(TEAM_FILES_STALE_TEXT)
          } else {
            fail(cleanIpcError(e, kind === 'approve' ? 'The changes could not be approved.' : 'The changes could not be rejected.'))
          }
          return false
        }
      }),
    [projectId, run, say, fail, takeResult]
  )

  const approve = useCallback((digest: string) => decide('approve', digest), [decide])
  const reject = useCallback((digest: string) => decide('reject', digest), [decide])

  const undo = useCallback(async (): Promise<void> => {
    await run('undo', async () => {
      try {
        // The "Undone. Rewrote ..." sentence is the notice that replaces the Undo one; no second message.
        takeResult(await window.orgai.teamFiles.undo({ projectId }))
        say(null)
      } catch (e) {
        say(cleanIpcError(e, 'Undo did not work.'))
      }
    })
  }, [projectId, run, say, takeResult])

  const key = statusKey(status)
  return {
    busy,
    message: msg && msg.key === key ? msg.text : null,
    error: err && err.key === key ? err.text : null,
    commit,
    enable,
    approve,
    reject,
    undo
  }
}
