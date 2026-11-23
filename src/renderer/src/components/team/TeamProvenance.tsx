import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Project, RunSummary } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { isOrgChangeRun } from '../../lib/orgChange'
import { planDateLabel } from '../../lib/engagementContext'
import { openProjectSettings } from '../../lib/openProjectSettings'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { cleanIpcError } from '../../lib/ipcError'
import { useOrgChange } from './useOrgChange'

const EMPTY: RunSummary[] = []

/** The first setup interview of a project (not an org change session), from what the renderer already holds. */
export function firstInterview(summaries: readonly Pick<RunSummary, 'kind' | 'prompt' | 'startedAt' | 'projectId'>[], projectId: string): number | undefined {
  let at: number | undefined
  for (const s of summaries) {
    if (s.projectId !== projectId || s.kind !== 'setup' || isOrgChangeRun(s)) continue
    if (at === undefined || s.startedAt < at) at = s.startedAt
  }
  return at
}

/**
 * The engagement team's provenance line (EngagementTeam board): when the Architect built the team, with "Read the
 * engagement plan" (Project settings, the plan section) and "Review with the Architect" (an org chart review session,
 * the same path as Branches > Review the org chart). Neutral wording (owner decision 6).
 */
export default function TeamProvenance({ project }: { project: Project }): ReactElement {
  const history = useAppStore((s) => s.historyByProject[project.id] ?? (s.selectedProjectId === project.id ? s.history : EMPTY))
  const live = useAppStore((s) => s.runs)
  const at = firstInterview([...history, ...Object.values(live).map((r) => r.summary)], project.id)
  const { liveRunId, revise } = useOrgChange(project)
  const [error, setError] = useState<string | null>(null)
  const date = planDateLabel(at)
  return (
    <div className="team-provenance" data-testid="team-provenance" role="note" aria-label="How this team was made">
      <span className="team-provenance-mark" aria-hidden="true">
        A
      </span>
      <span className="team-provenance-text">
        {date ? `The Architect built this team from your interview on ${date}.` : 'Describe a change and the Architect proposes it.'}
      </span>
      <button type="button" className="link-btn" data-testid="team-provenance-plan" onClick={() => openProjectSettings(project.id, PROJECT_SETTINGS_SECTIONS.engagementPlan)}>
        Read the engagement plan
      </button>
      <button
        type="button"
        className="link-btn"
        data-testid="team-provenance-review"
        onClick={() => {
          setError(null)
          revise('').catch((e: unknown) => setError(cleanIpcError(e)))
        }}
      >
        {liveRunId ? 'Open the Architect session' : 'Review with the Architect'}
      </button>
      {error && (
        <span className="team-provenance-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
