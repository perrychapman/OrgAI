import { useCallback, useRef, useState } from 'react'
import type { TeamFilesActionResult, TeamFilesStatus } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { TEAM_FILES_STALE_TEXT, isStaleDecision, undoneLine } from '../../lib/teamFiles'

export type TeamFilesBusy = 'commit' | 'enable' | 'approve' | 'reject' | 'undo' | null

/**
 * The Team tab's actions on a project's team files. Every result goes to the store (status and, for approve, reject,
 * undo and enable, the saved project). `message` is the last outcome in words (the status line says it, polite);
 * `error` is a failure the card shows next to its buttons.
 */
export function useTeamFilesActions(projectId: string): {
  busy: TeamFilesBusy
  message: string | null
  error: string | null
  clearMessage: () => void
  commit: () => Promise<void>
  enable: () => Promise<void>
  approve: (digest: string) => Promise<boolean>
  reject: (digest: string) => Promise<boolean>
  undo: () => Promise<void>
} {
  const [busy, setBusy] = useState<TeamFilesBusy>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

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
    setError(null)
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
        setMessage(r.ok ? r.message || 'Committed the team files.' : r.message || 'The team files could not be committed.')
      } catch (e) {
        setMessage(cleanIpcError(e, 'The team files could not be committed.'))
      }
    })
  }, [projectId, run])

  const enable = useCallback(async (): Promise<void> => {
    await run('enable', async () => {
      try {
        takeResult(await window.orgai.teamFiles.enable({ projectId }))
        setMessage('Team files are on again. They were written from the current team.')
      } catch (e) {
        setMessage(cleanIpcError(e, 'Team files could not be turned on.'))
      }
    })
  }, [projectId, run, takeResult])

  const decide = useCallback(
    async (kind: 'approve' | 'reject', digest: string): Promise<boolean> =>
      run(kind, async () => {
        try {
          const call = kind === 'approve' ? window.orgai.teamFiles.approve : window.orgai.teamFiles.reject
          takeResult(await call({ projectId, digest }))
          setMessage(
            kind === 'approve'
              ? 'Approved. The team in use now matches the files.'
              : 'Rejected. Runs keep the last approved team. OrgAI asks again when the files change.'
          )
          return true
        } catch (e) {
          if (isStaleDecision(e)) {
            await useAppStore.getState().refreshTeamFiles(projectId)
            setError(TEAM_FILES_STALE_TEXT)
          } else {
            setError(cleanIpcError(e, kind === 'approve' ? 'The changes could not be approved.' : 'The changes could not be rejected.'))
          }
          return false
        }
      }),
    [projectId, run, takeResult]
  )

  const approve = useCallback((digest: string) => decide('approve', digest), [decide])
  const reject = useCallback((digest: string) => decide('reject', digest), [decide])

  const undo = useCallback(async (): Promise<void> => {
    await run('undo', async () => {
      try {
        const status = takeResult(await window.orgai.teamFiles.undo({ projectId }))
        setMessage(undoneLine(status.lastUndo?.files ?? []))
      } catch (e) {
        setMessage(cleanIpcError(e, 'Undo did not work.'))
      }
    })
  }, [projectId, run, takeResult])

  return { busy, message, error, clearMessage: () => setMessage(null), commit, enable, approve, reject, undo }
}
