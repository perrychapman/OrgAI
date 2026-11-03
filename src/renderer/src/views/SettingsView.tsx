import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import ProjectConnection from '../components/connections/ProjectConnection'
import RemapNotices from '../components/RemapNotices'
import { GeneralSection } from '../components/settings/GeneralSection'
import { LimitsSection } from '../components/settings/LimitsSection'
import { MaintenanceSection } from '../components/settings/MaintenanceSection'
import { AgentsSection } from '../components/settings/AgentsSection'
import { SettingsPage } from '../components/settings/SettingsPage'
import type { SettingsNavItem } from '../components/settings/SettingsNav'
import { PROJECT_SETTINGS_PANES, normalizeProjectPane, type ProjectSettingsPane } from '../lib/settingsTarget'

/** Panes in nav order. Each pane holds the sections whose ids are listed in lib/settingsTarget. */
const PANES: SettingsNavItem[] = [
  { id: PROJECT_SETTINGS_PANES.general, label: 'General' },
  { id: PROJECT_SETTINGS_PANES.permissions, label: 'Permissions' },
  { id: PROJECT_SETTINGS_PANES.limits, label: 'Limits' },
  { id: PROJECT_SETTINGS_PANES.maintenance, label: 'Maintenance' }
]

/**
 * Project settings tab: a pane nav plus one pane at a time. The selected pane is remembered per project in the store.
 * Every edit goes through the store's debounced, tracked save, so the topbar SaveIndicator shows Saving… and Saved.
 * The org chart and the AI draft panel live on the Team tab.
 */
export default function SettingsView({ project }: { project: Project }): ReactElement {
  const updateProject = useAppStore((s) => s.updateProject)
  const stored = useAppStore((s) => s.projectSettingsPane[project.id])
  const setPane = useAppStore((s) => s.setProjectSettingsPane)
  const patch = (p: Partial<Project>): void => updateProject({ ...project, ...p })
  const pane: ProjectSettingsPane = normalizeProjectPane(stored)

  return (
    <div className="editor single">
      <SettingsPage title="Project settings" idBase="project-settings" label="Project settings sections" panes={PANES} active={pane} onSelect={(id) => setPane(project.id, id)}>
        {pane === 'general' && (
          <>
            <GeneralSection project={project} patch={patch} />
            {/* Interim shell: the pane pass replaces this with the spec 4.1 Connection section. */}
            <RemapNotices projectId={project.id} />
            <ProjectConnection project={project} />
          </>
        )}
        {pane === 'permissions' && <AgentsSection project={project} patch={patch} />}
        {pane === 'limits' && <LimitsSection project={project} patch={patch} />}
        {pane === 'maintenance' && <MaintenanceSection project={project} />}
      </SettingsPage>
    </div>
  )
}
