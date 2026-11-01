import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import DraftPanel from '../DraftPanel'

/** What the Team assistant is looking at: the whole team, or one role. Follows the canvas selection unless pinned (Brief 2c). */
export type TeamScope = { kind: 'team' } | { kind: 'role'; roleId: string }

/** Which mode of the assistant the tray shows. 'closed' renders nothing, so the tray takes no room. */
export type TeamAssistantMode = 'closed' | 'design'

/**
 * Body of the canvas frame's tray on the Team tab. Stub slot of the Team assistant (Brief 2c adds the Recommend mode,
 * scope chip, progress and recommendation cards). Today it only holds the Architect ("Design" mode), moved out of
 * the side panel so the role inspector stays visible while the user talks to it.
 */
export default function TeamAssistantTray({
  project,
  mode,
  onModeChange
}: {
  project: Project
  /** Reserved for the assistant's scope chip (Brief 2c); unused by the Design mode, which is always the whole team. */
  scope?: TeamScope
  mode: TeamAssistantMode
  onModeChange: (mode: TeamAssistantMode) => void
}): ReactElement | null {
  if (mode === 'closed') return null
  return (
    <div className="team-assistant" data-testid="team-assistant" data-mode={mode}>
      <DraftPanel project={project} variant="tray" onClose={() => onModeChange('closed')} />
    </div>
  )
}
