import type { ReactElement } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { openTeamFilesDecision } from '../../lib/menuActions'
import { teamPointerText } from '../../lib/teamFiles'

/**
 * A quiet pointer on the Live view while the project's team files wait on the user (changes to approve, or a file that
 * cannot be read). Runs keep the last approved team meanwhile; the card itself lives in the Team tab.
 */
export default function TeamFilesPointer({ projectId }: { projectId: string }): ReactElement | null {
  const text = useAppStore((s) => teamPointerText(s.teamFilesByProject[projectId]))
  if (!text) return null
  return (
    <span className="run-meta-item team-files-pointer" data-testid="team-files-pointer">
      {text}{' '}
      <button type="button" className="link-btn" onClick={() => openTeamFilesDecision(projectId)}>
        Open in Team
      </button>
    </span>
  )
}
