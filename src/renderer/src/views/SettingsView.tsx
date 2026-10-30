import type { ReactElement } from 'react'
import { useRef } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import ProjectConnection from '../components/connections/ProjectConnection'
import RemapNotices from '../components/RemapNotices'
import McpSection from '../components/mcp/McpSection'
import PluginsSection from '../components/mcp/PluginsSection'
import { GeneralSection } from '../components/settings/GeneralSection'
import { LimitsSection } from '../components/settings/LimitsSection'
import { MaintenanceSection } from '../components/settings/MaintenanceSection'
import { PermissionsSection } from '../components/settings/PermissionsSection'
import { SettingsNav, type SettingsNavItem } from '../components/settings/SettingsNav'
import { useSectionNav } from '../components/settings/useSectionNav'

/** Section ids in page order. Connection, MCP and plugins keep the ids their components own. */
const SECTIONS: SettingsNavItem[] = [
  { id: 'settings-section-general', label: 'General' },
  { id: 'settings-section-permissions', label: 'Permissions' },
  { id: 'settings-section-limits', label: 'Limits' },
  { id: 'settings-section-connection', label: 'Connection' },
  { id: 'settings-section-mcp', label: 'MCP and plugins' },
  { id: 'settings-section-maintenance', label: 'Maintenance' }
]
const SECTION_IDS = SECTIONS.map((s) => s.id)

/**
 * Project settings tab: a sub-nav plus sections. Every edit goes through the store's debounced, tracked save, so the
 * topbar SaveIndicator shows Saving… and Saved. The org chart and the AI draft panel live on the Org chart tab.
 */
export default function SettingsView({ project }: { project: Project }): ReactElement {
  const updateProject = useAppStore((s) => s.updateProject)
  const patch = (p: Partial<Project>): void => updateProject({ ...project, ...p })
  const scroller = useRef<HTMLDivElement>(null)
  const { active, go } = useSectionNav(SECTION_IDS, scroller)

  return (
    <div className="editor single">
      <div className="settings-scroll" ref={scroller}>
        <h2 className="settings-page-title">Project settings</h2>
        <div className="settings-layout">
          <SettingsNav items={SECTIONS} active={active} onSelect={go} />
          <div className="settings-col flow">
            <RemapNotices projectId={project.id} />
            <GeneralSection project={project} patch={patch} />
            <PermissionsSection project={project} patch={patch} />
            <LimitsSection project={project} patch={patch} />
            <ProjectConnection project={project} />
            <McpSection project={project} />
            <PluginsSection project={project} />
            <MaintenanceSection project={project} />
          </div>
        </div>
      </div>
    </div>
  )
}
