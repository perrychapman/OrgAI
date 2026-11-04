import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import { openNewChat, useAppStore } from '../store/useAppStore'
import { Button } from '../components/ui/Button'
import { hasParkedDraft } from '../components/dashboard/NewProjectForm'
import { HeroBand, type DashboardAnnouncement } from '../components/dashboard/HeroBand'
import { AttentionColumn } from '../components/dashboard/AttentionColumn'
import { useLastSeen } from '../components/dashboard/useLastSeen'
import { ProjectsGrid } from '../components/dashboard/ProjectsGrid'
import { FactsCards } from '../components/dashboard/FactsCards'
import { NewProjectDialog } from '../components/dashboard/NewProjectDialog'
import { FirstLaunch } from '../components/dashboard/FirstLaunch'

/** The last openNewProject() request this view acted on, so a request is consumed once. */
let consumedNewProjectRequest = 0

/** The home page (docs/design/dashboard.md): hero, attention column, project tiles and facts. */
export default function DashboardView(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const appInfo = useAppStore((s) => s.appInfo)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const loadAllHistory = useAppStore((s) => s.loadAllHistory)
  const newProjectRequest = useAppStore((s) => s.newProjectRequest)
  const { lastSeen, clearedAt, markAllSeen } = useLastSeen()
  // A form parked by its connection link comes back open.
  const [formOpen, setFormOpen] = useState(() => hasParkedDraft())
  const [announce, setAnnounce] = useState<DashboardAnnouncement | null>(null)
  const say = (text: string): void => setAnnounce((a) => ({ text, seq: (a?.seq ?? 0) + 1 }))

  useEffect(() => {
    void loadAppInfo()
    void loadAllHistory()
  }, [loadAppInfo, loadAllHistory])

  // openNewProject() opens the form once, whether it fired before or after this view mounted.
  useEffect(() => {
    if (newProjectRequest > consumedNewProjectRequest) {
      consumedNewProjectRequest = newProjectRequest
      setFormOpen(true)
    }
  }, [newProjectRequest])

  const mockAvailable = !!appInfo?.mockAdapter
  const empty = projects.length === 0

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        <div className="spacer" />
        {!empty && (
          <>
            <Button variant="secondary" icon={MessageSquare} onClick={() => void openNewChat()} testId="projects-new-chat">
              New chat
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setFormOpen(true)} testId="new-project">
              New project
            </Button>
          </>
        )}
      </div>
      <div className="dashboard" data-testid="dashboard">
        <div className="dashboard-grid">
          <HeroBand firstLaunch={empty} announce={announce} lastSeen={lastSeen} clearedAt={clearedAt} />
          {empty ? (
            <FirstLaunch mockAvailable={mockAvailable} />
          ) : (
            <>
              <AttentionColumn lastSeen={lastSeen} clearedAt={clearedAt} onMarkAllSeen={markAllSeen} />
              <ProjectsGrid onAnnounce={say} />
              <FactsCards />
            </>
          )}
        </div>
      </div>
      {!empty && <NewProjectDialog open={formOpen} onClose={() => setFormOpen(false)} mockAvailable={mockAvailable} />}
    </>
  )
}
