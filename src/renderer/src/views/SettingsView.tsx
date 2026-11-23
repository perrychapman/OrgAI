import type { ReactElement } from 'react'
import { useEffect } from 'react'
import type { Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { ContextNotesSection } from '../components/settings/ContextNotesSection'
import { EngagementPlanSection } from '../components/settings/EngagementPlanSection'
import { scrollWithin } from '../lib/scrollWithin'
import { useAppStore } from '../store/useAppStore'
import ProjectConnection from '../components/connections/ProjectConnection'
import RemapNotices from '../components/RemapNotices'
import { GeneralSection } from '../components/settings/GeneralSection'
import { LimitsSection } from '../components/settings/LimitsSection'
import { MaintenanceSection } from '../components/settings/MaintenanceSection'
import { PermissionsSection } from '../components/settings/PermissionsSection'
import { SettingsPage } from '../components/settings/SettingsPage'
import type { SettingsNavLink } from '../components/settings/SettingsNav'
import { APP_MENU_PANES, projectMenuPanes } from '../lib/settingsMenu'
import {
  PROJECT_SECTION_EVENT,
  PROJECT_SETTINGS_SECTIONS,
  normalizeProjectPane,
  requestAppSettingsSection,
  takeProjectSettingsSection,
  type ProjectSettingsPane
} from '../lib/settingsTarget'

/** The App group of the shared settings menu: each entry opens App settings on that pane. */
function appMenuLinks(): SettingsNavLink[] {
  return APP_MENU_PANES.map((p) => ({
    id: `app-${p.id}`,
    label: p.label,
    onOpen: () => {
      requestAppSettingsSection(p.id)
      useAppStore.getState().setView('appSettings')
    }
  }))
}

/**
 * Deep links to the engagement plan and context notes: scroll inside the settings scroller only, then focus the
 * section heading. Other General targets are left alone (their own surfaces handle them).
 */
function useEngagementSectionTarget(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined
    const take = (): void => {
      const target = takeProjectSettingsSection('general')
      if (target !== PROJECT_SETTINGS_SECTIONS.engagementPlan && target !== PROJECT_SETTINGS_SECTIONS.contextNotes) return
      requestAnimationFrame(() => {
        const section = document.getElementById(target)
        const heading = section?.querySelector<HTMLElement>('h3')
        scrollWithin(section, 'start')
        if (heading) {
          heading.setAttribute('tabindex', '-1')
          heading.focus({ preventScroll: true })
        }
      })
    }
    take()
    window.addEventListener(PROJECT_SECTION_EVENT, take)
    return () => window.removeEventListener(PROJECT_SECTION_EVENT, take)
  }, [active])
}

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
  const engagement = projectKindOf(project) === 'engagement'
  useEngagementSectionTarget(pane === 'general' && engagement)
  const panes = projectMenuPanes(engagement)

  return (
    <div className="editor single">
      <SettingsPage
        idBase="project-settings"
        label={`Project settings sections, ${project.name}`}
        panes={panes}
        active={pane}
        onSelect={(id) => setPane(project.id, id)}
        scope={`${engagement ? 'Engagement' : 'Project'}: ${project.name}`}
        navHeading={`${engagement ? 'Engagement' : 'Project'}: ${project.name}`}
        other={{ heading: 'App', label: 'App settings', links: appMenuLinks(), position: 'before' }}
      >
        {pane === 'general' && (
          <>
            <GeneralSection project={project} patch={patch} />
            {engagement && <EngagementPlanSection project={project} />}
            {engagement && <ContextNotesSection project={project} />}
            <RemapNotices projectId={project.id} />
            <ProjectConnection project={project} />
          </>
        )}
        {pane === 'permissions' && <PermissionsSection project={project} patch={patch} />}
        {pane === 'limits' && <LimitsSection project={project} patch={patch} />}
        {pane === 'maintenance' && <MaintenanceSection project={project} />}
      </SettingsPage>
    </div>
  )
}
