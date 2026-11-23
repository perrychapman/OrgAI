import type { ReactElement } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { showHidden } from '../../lib/hiddenChars'
import { clampLabel } from '../../lib/clampLabel'
import { PROPOSAL_NEXT_COPY, proposalNextLead } from '../../lib/proposalNext'
import { APP_SETTINGS_PANES, requestAppSettingsSection, requestSkillLibrary } from '../../lib/settingsTarget'

/**
 * What an approved proposal did and the one next step, as a note strip under the run header. It used to be a chip in the
 * run metadata line, which folds it into the "more" menu in a narrow frame; the user must see the result without opening
 * anything, so it has its own row and never folds. Test ids are unchanged. The org-roster note is also announced by RunMeta.
 */
export default function ProposalNextNote({ runId }: { runId: string }): ReactElement | null {
  const next = useAppStore((s) => s.proposalNextByRun[runId])
  const nextCopy = next ? PROPOSAL_NEXT_COPY[next.kind] : null
  if (!next || !nextCopy) return null
  const goNext = (): void => {
    const st = useAppStore.getState()
    if (next.kind === 'skillsLibrary') {
      requestSkillLibrary()
      st.setView('appSettings')
    } else if (next.kind === 'connectors') {
      requestAppSettingsSection(APP_SETTINGS_PANES.mcpLibrary)
      st.setView('appSettings')
    } else if (next.kind === 'mcpProject' || next.kind === 'mcpSecrets') {
      st.openProjectMcp(next.projectId)
    } else {
      if (st.selectedProjectId !== next.projectId) st.selectProject(next.projectId)
      st.setView('team')
    }
  }
  return (
    <div className="proposal-next-note" data-testid="proposal-next-note">
      <span data-testid="proposal-next-lead">{proposalNextLead(next)}</span>
      {next.roster && next.roster.deferred.length > 0 && (
        <ul className="proposal-next-list" data-testid="proposal-next-deferred">
          {next.roster.deferred.map((d, i) => (
            <li key={i}>
              {clampLabel(showHidden(d.name), 40)}: {clampLabel(showHidden(d.reason), 200)}
            </li>
          ))}
        </ul>
      )}{' '}
      <button type="button" className="link-btn" data-testid={nextCopy.testId} onClick={goNext}>
        {nextCopy.action}
      </button>
      <button type="button" className="link-btn" onClick={() => useAppStore.getState().noteProposalNext(runId, null)} aria-label="Dismiss this note">
        Dismiss
      </button>
    </div>
  )
}
