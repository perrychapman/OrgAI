import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import { openNewChat, useAppStore } from '../store/useAppStore'
import { Button } from '../components/ui/Button'
import { Banner } from '../components/ui/Banner'
import { forgetNoticeText } from '../lib/dashboard'
import { hasParkedDraft } from '../components/dashboard/NewProjectForm'
import { HeroBand, type DashboardAnnouncement } from '../components/dashboard/HeroBand'
import { EndedRegion, NeedsYouRegion, PausedRegion } from '../components/dashboard/AttentionColumn'
import { useLastSeen } from '../components/dashboard/useLastSeen'
import { ProjectsGrid } from '../components/dashboard/ProjectsGrid'
import { RightNowBand } from '../components/dashboard/RightNowBand'
import { ActivityStrip } from '../components/dashboard/ActivityStrip'
import { SetupGaps } from '../components/dashboard/SetupGaps'
import { useDashCaps } from '../components/dashboard/dashCaps'
import { useLiveRuns } from '../components/dashboard/useDashboardData'
import { NewProjectDialog } from '../components/dashboard/NewProjectDialog'
import { FirstLaunch } from '../components/dashboard/FirstLaunch'
import AppNavigateBanner from '../components/AppNavigateBanner'

/** The last openNewProject() request this view acted on, so a request is consumed once. */
let consumedNewProjectRequest = 0

/**
 * The home page (docs/design/dashboard-2.md): status bar, then the work area (Needs you, Right now, Last 14 days, To set
 * up, Paused, Recently ended), then the project tiles. First launch keeps dashboard.md section 6.
 */
export default function DashboardView(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const appInfo = useAppStore((s) => s.appInfo)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const loadAllHistory = useAppStore((s) => s.loadAllHistory)
  const newProjectRequest = useAppStore((s) => s.newProjectRequest)
  const forgetNotice = useAppStore((s) => s.forgetNotice)
  const setForgetNotice = useAppStore((s) => s.setForgetNotice)
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
  const [workEl, setWorkEl] = useState<HTMLDivElement | null>(null)
  const caps = useDashCaps(workEl)
  // No open run: the band is one line and the strip takes its column at the tall size (dashboard-2.md 6.7, 7.5).
  const nowEmpty = useLiveRuns().filter((r) => r.summary.status !== 'paused').length === 0

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
      <AppNavigateBanner />
      <div className="dashboard" data-testid="dashboard">
        <div className="dashboard-grid">
          {forgetNotice && (
            <div className="dash-forget-notice">
              <Banner tone="success" testId="forget-notice" onDismiss={() => setForgetNotice(null)}>
                {forgetNoticeText(forgetNotice.name, forgetNotice.result)}
              </Banner>
            </div>
          )}
          <HeroBand firstLaunch={empty} announce={announce} lastSeen={lastSeen} clearedAt={clearedAt} />
          {empty ? (
            <FirstLaunch mockAvailable={mockAvailable} />
          ) : (
            <>
              {/* DOM order is reading order: needs, now, strip, setup, paused, ended (dashboard-2.md 2.1). */}
              <div className="dash-work" ref={setWorkEl} data-now-empty={nowEmpty ? '' : undefined}>
                <div className="dash-area dash-area-needs">
                  <NeedsYouRegion caps={caps} onAnnounce={say} />
                </div>
                <div className="dash-area dash-area-now">
                  <RightNowBand caps={caps} onAnnounce={say} />
                </div>
                <div className="dash-area dash-area-strip">
                  <ActivityStrip size={nowEmpty ? 'tall' : 'compact'} />
                </div>
                <div className="dash-area dash-area-setup">
                  <SetupGaps caps={caps} />
                </div>
                <div className="dash-area dash-area-paused">
                  <PausedRegion caps={caps} />
                </div>
                <div className="dash-area dash-area-ended">
                  <EndedRegion caps={caps} lastSeen={lastSeen} clearedAt={clearedAt} onMarkAllSeen={markAllSeen} />
                </div>
              </div>
              <ProjectsGrid onAnnounce={say} />
            </>
          )}
        </div>
      </div>
      {!empty && <NewProjectDialog open={formOpen} onClose={() => setFormOpen(false)} mockAvailable={mockAvailable} />}
    </>
  )
}
