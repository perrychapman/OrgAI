import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus, SlidersHorizontal } from 'lucide-react'
import { openNewChat, useAppStore } from '../store/useAppStore'
import { Button } from '../components/ui/Button'
import { Banner } from '../components/ui/Banner'
import { Badge } from '../components/ui/Badge'
import { Icon } from '../components/ui/Icon'
import { forgetNoticeText } from '../lib/dashboard'
import { isDevBuild } from '../lib/buildChannel'
import { registerProjectHues } from '../lib/projectIdentity'
import { tokenMs } from '../lib/useExitPresence'
import {
  SECTION_TITLES,
  atEndText,
  moveSection,
  movedText,
  placeSections,
  pruneLayoutPins,
  resetLayout,
  setHidden,
  togglePin as togglePinIn,
  PIN_LIMIT,
  type DashSectionId
} from '../lib/dashboardLayout'
import { hasParkedDraft } from '../components/dashboard/NewProjectForm'
import { DashboardContext, type DashboardAnnouncement, type DashboardCtx } from '../components/dashboard/DashboardContext'
import { useDashboardLayout } from '../components/dashboard/useDashboardLayout'
import { Greeting } from '../components/dashboard/Greeting'
import { NeedsYouRegion } from '../components/dashboard/AttentionColumn'
import { useLastSeen } from '../components/dashboard/useLastSeen'
import { ProjectsGrid } from '../components/dashboard/ProjectsGrid'
import { RightNowBand } from '../components/dashboard/RightNowBand'
import { ResumeSection } from '../components/dashboard/ResumeSection'
import { TodaySection } from '../components/dashboard/TodaySection'
import { WeekSection } from '../components/dashboard/WeekSection'
import { SetupGaps } from '../components/dashboard/SetupGaps'
import { CommitsSection } from '../components/dashboard/CommitsSection'
import { EngagementsSection } from '../components/dashboard/EngagementsSection'
import { useDashCaps } from '../components/dashboard/dashCaps'
import { NewProjectDialog } from '../components/dashboard/NewProjectDialog'
import { FirstLaunch } from '../components/dashboard/FirstLaunch'
import { SecretNotices } from '../components/dashboard/SecretNotices'
import AppNavigateBanner from '../components/AppNavigateBanner'

/** The last openNewProject() request this view acted on, so a request is consumed once. */
let consumedNewProjectRequest = 0

/**
 * The board's entrance (Visual pass, motion): the tiles rise in, staggered, the first time the Dashboard shows in an app
 * session only; a later visit, a data refresh or a tile already on screen never animates. The window is short so a tile
 * filled by a slow load does not rise late.
 */
let boardEntered = false
const BOARD_ENTRANCE_MS = 700

const CONTROL = (id: DashSectionId, testId: string): string => `[data-testid=dash-section-controls][data-section="${id}"] [data-testid="${testId}"]`

/** Focus an element found after React has rendered (a moved section's DOM node may have been re-inserted). */
function focusLater(selector: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: false }))
}

/** One `.motion-ring` on a section's slot after a move (restarts on a second move); none under reduced motion. */
function ringSection(id: DashSectionId): void {
  if (tokenMs('--dur-slow') < 1) return
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid=dash-section][data-section="${id}"]`)
    if (!el) return
    el.classList.remove('motion-ring')
    void el.offsetWidth
    el.classList.add('motion-ring')
    el.addEventListener('animationend', () => el.classList.remove('motion-ring'), { once: true })
  })
}

/**
 * The home page (docs/design/dashboard-overhaul.md): the greeting with its brief, then the fixed sections (Waiting on you,
 * To finish setting up), then the five arrangeable sections in the person's order, then the footer. First launch keeps
 * the start choice under the greeting.
 */
export default function DashboardView(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const appInfo = useAppStore((s) => s.appInfo)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const loadAllHistory = useAppStore((s) => s.loadAllHistory)
  const newProjectRequest = useAppStore((s) => s.newProjectRequest)
  const forgetNotice = useAppStore((s) => s.forgetNotice)
  const setForgetNotice = useAppStore((s) => s.setForgetNotice)
  const { lastSeen, firstVisit } = useLastSeen()
  // A form parked by its connection link comes back open.
  const [formOpen, setFormOpen] = useState(() => hasParkedDraft())
  const [announce, setAnnounce] = useState<DashboardAnnouncement | null>(null)
  const say = useCallback((text: string): void => setAnnounce((a) => ({ text, seq: (a?.seq ?? 0) + 1 })), [])

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
  // Project identity hues for this list, before any section renders (idempotent for the same ids; projectIdentity.ts).
  registerProjectHues(projects.map((p) => p.id))

  // Entrance: once per app session, never under reduced motion or Pause motion (the duration token collapses then).
  const [entering, setEntering] = useState(() => !boardEntered && tokenMs('--dur-slow') >= 1)
  useEffect(() => {
    boardEntered = true
    if (!entering) return
    const t = window.setTimeout(() => setEntering(false), BOARD_ENTRANCE_MS)
    return () => window.clearTimeout(t)
  }, [entering])

  // ---- Layout and customise (sections 4.2, 6) ----
  const [layout, updateLayout] = useDashboardLayout()
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [customising, setCustomising] = useState(false)
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null)
  const caps = useDashCaps(pageEl)
  const [emptyOf, setEmptyOf] = useState<Partial<Record<DashSectionId, boolean>>>({})
  const reportEmpty = useCallback((id: DashSectionId, isEmpty: boolean) => setEmptyOf((m) => (m[id] === isEmpty ? m : { ...m, [id]: isEmpty })), [])
  const customiseRef = useRef<HTMLButtonElement>(null)

  // A deleted project's pin goes with it. Only once projects are known, so a load in progress never drops pins.
  useEffect(() => {
    if (projects.length > 0) updateLayout((l) => pruneLayoutPins(l, projects.map((p) => p.id)))
  }, [projects, updateLayout])

  const visible = layout.order.filter((id) => !layout.hidden.includes(id) && emptyOf[id] === false)
  const placed = placeSections(visible, caps.wide && !customising)
  const spanKey = placed.map((p) => `${p.id}:${p.span}`).join(',')

  const move = useCallback(
    (id: DashSectionId, dir: 'up' | 'down') => {
      const next = moveSection(layoutRef.current, id, dir)
      if (next === layoutRef.current) {
        say(atEndText(id, dir))
        return
      }
      updateLayout(() => next)
      say(movedText(next, id, dir))
      focusLater(CONTROL(id, `dash-section-${dir}`))
      ringSection(id)
    },
    [say, updateLayout]
  )
  const setSectionHidden = useCallback(
    (id: DashSectionId, hide: boolean) => {
      updateLayout((l) => setHidden(l, id, hide))
      say(`${SECTION_TITLES[id]} ${hide ? 'hidden' : 'shown'}.`)
      focusLater(CONTROL(id, hide ? 'dash-section-show' : 'dash-section-hide'))
    },
    [say, updateLayout]
  )
  const togglePin = useCallback(
    (projectId: string, name: string): boolean => {
      const prev = layoutRef.current
      const next = togglePinIn(prev, projectId)
      if (next === prev) {
        say(`The pin limit is ${PIN_LIMIT}.`)
        return false
      }
      updateLayout(() => next)
      // Pins keep pin order, so a new pin is first only when it is the only one; otherwise say where it went.
      const at = next.pinned.indexOf(projectId)
      say(at < 0 ? `Unpinned ${name}.` : at === 0 ? `Pinned ${name}. It is now first.` : `Pinned ${name}. It is pin ${at + 1} of ${next.pinned.length}.`)
      return true
    },
    [say, updateLayout]
  )
  const reset = (): void => {
    updateLayout(resetLayout)
    say('Layout reset to the default.')
  }
  const leaveCustomise = (): void => {
    setCustomising(false)
    requestAnimationFrame(() => customiseRef.current?.focus({ preventScroll: true }))
  }
  const openCustomise = (): void => {
    setCustomising(true)
    requestAnimationFrame(() => customiseRef.current?.focus({ preventScroll: true }))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!customising || e.key !== 'Escape' || e.defaultPrevented) return
    const t = e.target as HTMLElement
    // A popover, menu or dialog takes its own Escape first.
    if (t.closest('dialog, [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [popover], .popover-panel')) return
    e.preventDefault()
    leaveCustomise()
  }

  const ctx = useMemo<DashboardCtx>(
    () => ({
      layout,
      customising,
      caps,
      announce: say,
      togglePin,
      move,
      setSectionHidden,
      reportEmpty,
      spanOf: (id) => placed.find((p) => p.id === id)?.span ?? 'full'
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, customising, caps, say, togglePin, move, setSectionHidden, reportEmpty, spanKey]
  )

  const sections: Record<DashSectionId, ReactElement> = {
    resume: <ResumeSection key="resume" lastSeen={lastSeen} />,
    today: <TodaySection key="today" />,
    working: <RightNowBand key="working" caps={caps} onAnnounce={say} />,
    week: <WeekSection key="week" />,
    engagements: <EngagementsSection key="engagements" />,
    projects: <ProjectsGrid key="projects" onAnnounce={say} />
  }

  const customiseButton = empty ? undefined : (
    <button
      ref={customiseRef}
      type="button"
      className="btn ghost dash-customise"
      data-testid="dash-customise"
      aria-expanded={customising}
      aria-controls={customising ? 'dash-customise-bar' : undefined}
      onClick={() => (customising ? leaveCustomise() : setCustomising(true))}
    >
      <Icon icon={SlidersHorizontal} size="sm" />
      <span className="dash-customise-label">{customising ? 'Done' : 'Customise'}</span>
    </button>
  )

  const version = appInfo?.version
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
      <div className="dashboard" data-testid="dashboard" data-customising={customising ? '' : undefined} onKeyDown={onKeyDown}>
        <DashboardContext.Provider value={ctx}>
          <div className="dash-page" ref={setPageEl} data-tracks={caps.wide && !customising ? '2' : '1'} data-entering={entering ? '' : undefined}>
            <SecretNotices />
            {forgetNotice && (
              <div className="dash-forget-notice">
                <Banner tone="success" testId="forget-notice" onDismiss={() => setForgetNotice(null)}>
                  {forgetNoticeText(forgetNotice.name, forgetNotice.result)}
                </Banner>
              </div>
            )}
            <Greeting firstLaunch={empty} announce={announce} onAnnounce={say} customise={customiseButton} lastSeen={lastSeen} firstVisit={firstVisit} />
            {!empty && customising && (
              <div className="dash-customise-bar motion-fade" id="dash-customise-bar" data-testid="dash-customise-bar">
                <p>Move, hide or show sections. Changes save as you go.</p>
                <Button variant="ghost" size="sm" testId="dash-customise-reset" onClick={reset}>
                  Reset layout
                </Button>
              </div>
            )}
            {empty ? (
              <FirstLaunch mockAvailable={mockAvailable} />
            ) : (
              <>
                {/* The lead band (Visual pass): fixed, never hidden or moved (a decision or a blocker must not be hideable).
                    Left and widest: Waiting on you and To finish setting up; right: Commits this week. One column below the
                    two-track width, attention first. */}
                <div className="dash-lead" data-tracks={caps.wide && !customising ? '2' : '1'}>
                  <div className="dash-lead-main">
                    <NeedsYouRegion caps={caps} onAnnounce={say} />
                    <SetupGaps caps={caps} />
                  </div>
                  <div className="dash-lead-side">
                    <CommitsSection />
                  </div>
                </div>
                <div className="dash-arranged">{layout.order.map((id) => sections[id])}</div>
                {!customising && layout.order.every((id) => layout.hidden.includes(id)) && (
                  <p className="dash-all-hidden" data-testid="dash-all-hidden">
                    All sections are hidden.
                    <Button variant="ghost" size="sm" testId="dash-all-hidden-show" onClick={openCustomise}>
                      Show sections
                    </Button>
                  </p>
                )}
              </>
            )}
            <footer className="dash-footer" data-testid="dashboard-app-facts">
              {version && <span className="dash-num">OrgAI {version}</span>}
              {isDevBuild(version) && <Badge tone="info">Dev</Badge>}
              {appInfo?.mockAdapter && <Badge tone="warning">Mock adapter</Badge>}
            </footer>
          </div>
        </DashboardContext.Provider>
      </div>
      {!empty && <NewProjectDialog open={formOpen} onClose={() => setFormOpen(false)} mockAvailable={mockAvailable} />}
    </>
  )
}
