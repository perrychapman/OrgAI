import type { ReactElement } from 'react'
import { useId } from 'react'
import type { Project, RunSummary } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { isOrgChangeRun } from '../../lib/orgChange'
import { planDateLabel } from '../../lib/engagementContext'
import { openProjectSettings } from '../../lib/openProjectSettings'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { useArchitectForm } from './ArchitectDialog'

const EMPTY: RunSummary[] = []

/** When the project's first setup interview started (not an org change session), from what the renderer already holds. */
export function firstInterview(summaries: readonly Pick<RunSummary, 'kind' | 'prompt' | 'startedAt' | 'projectId'>[], projectId: string): number | undefined {
  let at: number | undefined
  for (const s of summaries) {
    if (s.projectId !== projectId || s.kind !== 'setup' || isOrgChangeRun(s)) continue
    if (at === undefined || s.startedAt < at) at = s.startedAt
  }
  return at
}

/**
 * The engagement team's provenance line (EngagementTeam board): the date of the first Architect interview, "Read the
 * engagement plan" (Project settings, the plan section) and "Review with the Architect" (the Architect form's full
 * review: it asks before starting, says what it costs and holds while it starts). Neutral wording (owner decision 6).
 * The sentence names the interview, not the team: a run summary cannot say whether its proposal was applied (review M4).
 */
export default function TeamProvenance({ project }: { project: Project }): ReactElement {
  const history = useAppStore((s) => s.historyByProject[project.id] ?? (s.selectedProjectId === project.id ? s.history : EMPTY))
  const live = useAppStore((s) => s.runs)
  const at = firstInterview([...history, ...Object.values(live).map((r) => r.summary)], project.id)
  const form = useArchitectForm(project)
  const costId = useId()
  const date = planDateLabel(at)
  return (
    <div className="team-provenance" data-testid="team-provenance" role="note" aria-label="About this team">
      <span className="team-provenance-mark" aria-hidden="true">
        A
      </span>
      <span className="team-provenance-text" title={date ? `Your first Architect interview was on ${date}.` : undefined}>
        {date ? `Your first Architect interview was on ${date}.` : 'Describe a change and the Architect proposes it.'}
      </span>
      <button type="button" className="link-btn" data-testid="team-provenance-plan" onClick={() => openProjectSettings(project.id, PROJECT_SETTINGS_SECTIONS.engagementPlan)}>
        Read the engagement plan
      </button>
      <button
        type="button"
        className="link-btn"
        data-testid="team-provenance-review"
        aria-describedby={costId}
        disabled={form.busy}
        onClick={() => void form.submit()}
      >
        {form.busy ? 'Starting…' : form.liveRunId ? 'Open the Architect session' : 'Review with the Architect'}
      </button>
      <span id={costId} className="sr-only">
        {form.cost}
      </span>
      {form.error && (
        <span className="team-provenance-error" role="alert">
          {form.error}
        </span>
      )}
      {form.confirmDialog}
    </div>
  )
}
