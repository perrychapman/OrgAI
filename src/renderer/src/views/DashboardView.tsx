import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Button } from '../components/ui/Button'
import { Banner } from '../components/ui/Banner'
import { Icon } from '../components/ui/Icon'
import { forgetNoticeText } from '../lib/dashboard'
import { registerProjectHues } from '../lib/projectIdentity'
import { tokenMs } from '../lib/useExitPresence'
import { useReducedMotion } from '../lib/canvas'
import { usePageArrival } from '../lib/usePageArrival'
import {
  FOCUS_TITLES,
  SECTION_TITLES,
  atEndText,
  moveSection,
  movedText,
  placeSections,
  pruneLayoutPins,
  resetLayout,
  setFocus,
  setHidden,
  setMotionPaused,
  togglePin as togglePinIn,
  PIN_LIMIT,
  type DashSectionId,
  type FocusFigure
} from '../lib/dashboardLayout'
import { hasParkedDraft } from '../components/dashboard/NewProjectForm'
import { DashboardContext, type DashboardAnnouncement, type DashboardCtx } from '../components/dashboard/DashboardContext'
import { useDashboardLayout } from '../components/dashboard/useDashboardLayout'
import { Briefing } from '../components/dashboard/Briefing'
import { CustomiseBar } from '../components/dashboard/CustomiseBar'
import { NeedsYouRegion } from '../components/dashboard/AttentionColumn'
import { useLastSeen } from '../components/dashboard/useLastSeen'
import { useArrivalSignature } from '../components/dashboard/useDashboardData'
import { ProjectsGrid } from '../components/dashboard/ProjectsGrid'
import { RightNowBand } from '../components/dashboard/RightNowBand'
import { PickUpSection } from '../components/dashboard/PickUpSection'
import { UpNextSection } from '../components/dashboard/UpNextSection'
import { TodosSection } from '../components/dashboard/TodosSection'
import { WeekSection } from '../components/dashboard/WeekSection'
import { CommitsSection } from '../components/dashboard/CommitsSection'
import { EngagementsSection } from '../components/dashboard/EngagementsSection'
import { useDashCaps } from '../components/dashboard/dashCaps'
import { NewProjectDialog } from '../components/dashboard/NewProjectDialog'
import { FirstLaunch } from '../components/dashboard/FirstLaunch'
import { SecretNotices } from '../components/dashboard/SecretNotices'
import AppNavigateBanner from '../components/AppNavigateBanner'

/** The last openNewProject() request this view acted on, so a request is consumed once. */
let consumedNewProjectRequest = 0

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
 * The home page (docs/design/dashboard-usage-redesign/project/dashboard.md): the Briefing hero card, then the work area
 * (Needs you, Right now and the arrangeable sections in the person's order), one page scroll. Needs you and Right now are
 * fixed regions drawn only with content. From an 880 px container the work area is two columns (Needs you and, when it is
 * the first visible arrangeable section, Your week on the left; Right now on the right), from 1280 px Pick up and Up next
 * share a row, under 880 px it is one column in reading order. First launch keeps the start choice under the greeting.
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

  // ---- Layout and customise ----
  const [layout, updateLayout] = useDashboardLayout()
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [customising, setCustomising] = useState(false)
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null)
  const caps = useDashCaps(pageEl)
  const [emptyOf, setEmptyOf] = useState<Partial<Record<DashSectionId, boolean>>>({})
  const reportEmpty = useCallback((id: DashSectionId, isEmpty: boolean) => setEmptyOf((m) => (m[id] === isEmpty ? m : { ...m, [id]: isEmpty })), [])
  const customiseRef = useRef<HTMLButtonElement>(null)

  // Page arrival (lib/usePageArrival): staged once when the person arrives or the app opens here, and again only when what
  // the page shows has changed since they last saw it (a decision, a run opening or ending, a project added).
  // The signature is selected piece by piece (useArrivalSignature), so a run event that changes none of them does not render the page.
  const signature = useArrivalSignature()
  // Pause motion (saved) also stops the page's arrival, not only the loops.
  const staged = usePageArrival('dashboard', signature)
  const arriving = staged && !layout.motionPaused
  // Pause motion (saved) or reduced motion (the OS switch or Appearance): the live loops show their static cue.
  const reduced = useReducedMotion()
  const still = layout.motionPaused || reduced
  // Right now's breathing marks (reported by the band) come off the page's budget of 12 before Team pulse breathes.
  const [bandBreathing, setBandBreathing] = useState(0)
  const reportBreathing = useCallback((n: number) => setBandBreathing((v) => (v === n ? v : n)), [])

  // A deleted project's pin goes with it. Only once projects are known, so a load in progress never drops pins.
  useEffect(() => {
    if (projects.length > 0) updateLayout((l) => pruneLayoutPins(l, projects.map((p) => p.id)))
  }, [projects, updateLayout])

  const visible = layout.order.filter((id) => !layout.hidden.includes(id) && emptyOf[id] === false)
  const placed = placeSections(visible, caps.pair && !customising)
  // Your week joins the work area's left column only while it is the first visible arrangeable section.
  const lead: DashSectionId | null = !customising && visible[0] === 'week' ? 'week' : null
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
  const chooseFocus = (focus: FocusFigure): void => {
    updateLayout((l) => setFocus(l, focus))
    say(`Your week now leads with ${FOCUS_TITLES[focus].toLowerCase()}.`)
  }
  const pauseMotion = (paused: boolean): void => {
    updateLayout((l) => setMotionPaused(l, paused))
    say(paused ? 'Motion paused.' : 'Motion resumed.')
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
      spanOf: (id) => placed.find((p) => p.id === id)?.span ?? 'full',
      lead,
      arriving,
      still,
      bandBreathing,
      reportBreathing
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, customising, caps, say, togglePin, move, setSectionHidden, reportEmpty, spanKey, lead, arriving, still, bandBreathing, reportBreathing]
  )

  const sections: Record<DashSectionId, ReactElement> = {
    week: <WeekSection key="week" />,
    pickup: <PickUpSection key="pickup" lastSeen={lastSeen} />,
    upnext: <UpNextSection key="upnext" />,
    projects: <ProjectsGrid key="projects" onAnnounce={say} />,
    engagements: <EngagementsSection key="engagements" />,
    commits: <CommitsSection key="commits" />,
    todos: <TodosSection key="todos" />
  }

  // The quick actions' last, quiet button.
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

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
      </div>
      <AppNavigateBanner />
      <div className="dashboard" data-testid="dashboard" data-customising={customising ? '' : undefined} onKeyDown={onKeyDown}>
        <DashboardContext.Provider value={ctx}>
          <div className="dash-page" ref={setPageEl} data-motion-paused={still ? '' : undefined} data-arriving={arriving ? '' : undefined}>
            <div className="dash-inner">
              <SecretNotices />
              {forgetNotice && (
                <div className="dash-forget-notice">
                  <Banner tone="success" testId="forget-notice" onDismiss={() => setForgetNotice(null)}>
                    {forgetNoticeText(forgetNotice.name, forgetNotice.result)}
                  </Banner>
                </div>
              )}
              <Briefing
                firstLaunch={empty}
                announce={announce}
                onAnnounce={say}
                customise={customiseButton}
                onNewProject={() => setFormOpen(true)}
                motionPaused={layout.motionPaused}
                onMotionPaused={pauseMotion}
                lastSeen={lastSeen}
                firstVisit={firstVisit}
              />
              {!empty && customising && <CustomiseBar focus={layout.focus} onFocus={chooseFocus} onReset={reset} />}
              {empty ? (
                <FirstLaunch mockAvailable={mockAvailable} />
              ) : (
                <div className="dash-work" data-testid="dash-work" data-customising={customising ? '' : undefined}>
                  {/* Fixed regions, in reading order: never hidden, reordered or listed in Customise, drawn only with content. */}
                  <NeedsYouRegion caps={caps} onAnnounce={say} />
                  <RightNowBand caps={caps} onAnnounce={say} />
                  {layout.order.map((id) => sections[id])}
                  {!customising && layout.order.every((id) => layout.hidden.includes(id)) && (
                    <p className="dash-all-hidden" data-testid="dash-all-hidden">
                      All sections are hidden.
                      <Button variant="ghost" size="sm" testId="dash-all-hidden-show" onClick={openCustomise}>
                        Show sections
                      </Button>
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </DashboardContext.Provider>
      </div>
      {!empty && <NewProjectDialog open={formOpen} onClose={() => setFormOpen(false)} mockAvailable={mockAvailable} />}
    </>
  )
}
