import { useAppStore } from '../store/useAppStore'
import { projectPaneForSection, requestProjectSettingsSection, type ProjectSettingsSection } from './settingsTarget'

/**
 * Open a project's Settings tab on the pane holding `section` and land there (the pane opens its Advanced first when
 * the target lives in it). Used by the permission card's "Fewer prompts" link and the Team tab's "Team assistant settings".
 */
export function openProjectSettings(projectId: string, section: ProjectSettingsSection): void {
  const pane = projectPaneForSection(section)
  if (!pane) return
  const st = useAppStore.getState()
  if (st.selectedProjectId !== projectId) st.selectProject(projectId)
  st.setProjectSettingsPane(projectId, pane)
  st.setView('settings')
  requestProjectSettingsSection(section)
}
