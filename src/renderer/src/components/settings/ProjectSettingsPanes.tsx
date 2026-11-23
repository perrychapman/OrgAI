import type { ReactElement } from 'react'
import { useEffect } from 'react'
import type { Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { scrollWithin } from '../../lib/scrollWithin'
import { PROJECT_SECTION_EVENT, PROJECT_SETTINGS_SECTIONS, takeProjectSettingsSection, type ProjectSettingsPane } from '../../lib/settingsTarget'
import ProjectConnection from '../connections/ProjectConnection'
import RemapNotices from '../RemapNotices'
import { ContextNotesSection } from './ContextNotesSection'
import { EngagementPlanSection } from './EngagementPlanSection'
import { GeneralSection } from './GeneralSection'
import { LimitsSection } from './LimitsSection'
import { MaintenanceSection } from './MaintenanceSection'
import { PermissionsSection } from './PermissionsSection'
import { WorkCopiesSection } from './WorkCopiesSection'
import { BranchRulesSection } from './BranchRulesSection'

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
 * A project's (or engagement's) settings panes inside the one Settings view. Every edit goes through the store's
 * debounced, tracked save, so the topbar SaveIndicator shows Saving… and Saved. The org chart and the AI draft panel
 * live on the Team tab.
 */
export function ProjectSettingsPanes({ project, pane }: { project: Project; pane: ProjectSettingsPane }): ReactElement {
  const updateProject = useAppStore((s) => s.updateProject)
  const patch = (p: Partial<Project>): void => updateProject({ ...project, ...p })
  const engagement = projectKindOf(project) === 'engagement'
  useEngagementSectionTarget(pane === 'general' && engagement)
  return (
    <>
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
      {pane === 'maintenance' && (
        <>
          <WorkCopiesSection project={project} patch={patch} />
          {!engagement && <BranchRulesSection project={project} patch={patch} />}
          <MaintenanceSection project={project} />
        </>
      )}
    </>
  )
}
