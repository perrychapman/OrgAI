import { useCallback } from 'react'
import type { Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { isRunLive, useAppStore } from '../../store/useAppStore'
import { needsYou } from '../../lib/runChains'
import { liveOrgChangeRun, orgChangePrompt } from '../../lib/orgChange'

/** Spoken once the session's tab is open on Live (focus is already in its composer or on its card). */
export const ORG_CHANGE_STARTED = 'Org change session started. Its questions and proposals appear here.'
export const ORG_CHANGE_SENT = 'Sent to the open org change session.'

export interface OrgChangeControls {
  /** The project's open org change session (needs-you first, else the newest), or null. */
  liveRunId: string | null
  /** Show the open session on Live: its first card when one waits, else its composer. */
  open: () => Promise<void>
  /**
   * Start a session, or (while one is open) send the change into it, so two Architects never revise one chart at once.
   * Empty text with an open session only opens it. Throws what main refused.
   */
  revise: (text: string) => Promise<void>
}

/** The one start path of org change sessions (Team > Design and Settings > Maintenance). */
export function useOrgChange(project: Project): OrgChangeControls {
  const liveRunId = useAppStore((s) => liveOrgChangeRun(Object.values(s.runs), project.id, isRunLive, needsYou)?.summary.id ?? null)
  const startSetup = useAppStore((s) => s.startSetup)
  const openRun = useAppStore((s) => s.openRun)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const setTabNotice = useAppStore((s) => s.setTabNotice)

  const open = useCallback(async (): Promise<void> => {
    if (!liveRunId) return
    const run = useAppStore.getState().runs[liveRunId]
    if (run && needsYou(run)) {
      await jumpToDecision(project.id, liveRunId)
      return
    }
    if (useAppStore.getState().selectedProjectId !== project.id) useAppStore.getState().selectProject(project.id)
    await openRun(liveRunId)
    // The Live view mounts with this render; the composer takes a token bumped after its mount.
    window.requestAnimationFrame(() => focusComposer())
  }, [liveRunId, project.id, openRun, jumpToDecision, focusComposer])

  const revise = useCallback(
    async (text: string): Promise<void> => {
      const t = text.trim()
      if (liveRunId) {
        if (t) await window.orgai.runs.send({ runId: liveRunId, text: t })
        await open()
        if (t) setTabNotice(ORG_CHANGE_SENT)
        return
      }
      await startSetup(orgChangePrompt(t, projectKindOf(project)))
      window.requestAnimationFrame(() => focusComposer())
      setTabNotice(ORG_CHANGE_STARTED)
    },
    [liveRunId, open, startSetup, project, focusComposer, setTabNotice]
  )

  return { liveRunId, open, revise }
}
