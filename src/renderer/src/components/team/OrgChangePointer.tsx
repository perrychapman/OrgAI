import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { needsYou } from '../../lib/runChains'
import { statusOfRun, statusText } from '../../lib/runStatus'
import { displayRunName } from '../../lib/orgChange'
import { useOrgChange } from './useOrgChange'

/**
 * One quiet line in the Team tray (both modes) while an org change session of this project is open: its name, its
 * status word and "Open session", which shows the run on Live. The cards and the composer live there, never here.
 */
export function OrgChangePointer({ project }: { project: Project }): ReactElement | null {
  const { liveRunId, open } = useOrgChange(project)
  const run = useAppStore((s) => (liveRunId ? s.runs[liveRunId] : undefined))
  if (!run) return null
  const word = statusText(statusOfRun(run, project, needsYou(run)))
  const name = displayRunName(run.summary)
  return (
    <p className="org-change-pointer" data-testid="org-change-pointer" data-run={run.summary.id} data-status={run.summary.status}>
      <span className="org-change-pointer-name">
        {name} is open · {word}.
      </span>
      <button type="button" className="link-btn" data-testid="org-change-open" aria-label={`Open session: ${name}`} onClick={() => void open()}>
        Open session
      </button>
    </p>
  )
}
