import type { ReactElement } from 'react'
import { useCallback, useRef, useState } from 'react'
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

/** Section ids in page order. Connection, MCP and plugins keep the ids their components own. */
const SECTIONS: SettingsNavItem[] = [
  { id: 'settings-section-general', label: 'General' },
  { id: 'settings-section-permissions', label: 'Permissions' },
  { id: 'settings-section-limits', label: 'Limits' },
  { id: 'settings-section-connection', label: 'Connection' },
  { id: 'settings-section-mcp', label: 'MCP and plugins' },
  { id: 'settings-section-maintenance', label: 'Maintenance' }
]

/** Header offset (matches the section scroll-margin) plus a share of the viewport: a section counts as current once its top is this far down. */
const ACTIVE_OFFSET_PX = 48
const ACTIVE_VIEWPORT_SHARE = 0.35

/**
 * Project settings tab: a sub-nav plus sections. Every edit goes through the store's debounced, tracked save, so the
 * topbar SaveIndicator shows Saving… and Saved. The org chart and the AI draft panel live on the Org chart tab.
 */
export default function SettingsView({ project }: { project: Project }): ReactElement {
  const updateProject = useAppStore((s) => s.updateProject)
  const patch = (p: Partial<Project>): void => updateProject({ ...project, ...p })
  const scroller = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(SECTIONS[0].id)

  const go = useCallback((id: string): void => {
    setActive(id)
    document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [])

  const onScroll = useCallback((): void => {
    const box = scroller.current
    if (!box) return
    const top = box.getBoundingClientRect().top
    const line = ACTIVE_OFFSET_PX + box.clientHeight * ACTIVE_VIEWPORT_SHARE
    let current = SECTIONS[0].id
    let best = -Infinity
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id)
      if (!el) continue
      // The section whose top is nearest above the line wins, whatever the DOM order.
      const rel = el.getBoundingClientRect().top - top
      if (rel <= line && rel > best) {
        best = rel
        current = s.id
      }
    }
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) current = SECTIONS[SECTIONS.length - 1].id
    setActive(current)
  }, [])

  return (
    <div className="editor single">
      <div className="settings-scroll" ref={scroller} onScroll={onScroll}>
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
