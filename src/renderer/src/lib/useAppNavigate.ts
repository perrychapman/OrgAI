import { useEffect, useSyncExternalStore } from 'react'
import type { AppNavigateEvent } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { openNewProject, useAppStore } from '../store/useAppStore'
import { navigationFor, type NavigationPlan, type NavTarget } from './appNavigate'
import { announceMenu, menuStateFor, openKeyboardShortcuts } from './menuActions'
import { focusPaneHeading, requestAppSettingsSection, requestProjectSettingsSection } from './settingsTarget'
import { openSettingsAdvanced } from '../components/settings/SettingsAdvanced'
import { scrollWithin } from './scrollWithin'

/**
 * Performs agent navigations (open_in_app, docs/design/self-help.md): subscribes to window.orgai.onAppNavigate once,
 * plans with `navigationFor`, drives the store and the existing deep links, lands focus on the destination heading,
 * then shows one visible banner at the destination (AppNavigateBanner) and says the same sentence through
 * announceMenu (the run tabs' notice on a run view, else the app-wide `menu-announce`).
 */

export interface NavBanner {
  /** Bumped per navigation so the banner re-renders (and a repeated sentence is shown again). */
  seq: number
  message: string
  /** The run that asked; "Back to chat" returns there. Absent for a refusal that never left the chat. */
  runId?: string
  /** The location key the banner belongs to; leaving it clears the banner. */
  home?: string
}

let banner: NavBanner | null = null
let seq = 0
const listeners = new Set<() => void>()
function setBanner(next: NavBanner | null): void {
  banner = next
  for (const fn of [...listeners]) fn()
}
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export const currentNavBanner = (): NavBanner | null => banner
export function useNavBanner(): NavBanner | null {
  return useSyncExternalStore(subscribe, currentNavBanner, currentNavBanner)
}
/** Dismiss: the banner goes and focus moves to the page's heading instead of falling to <body> (review L1). */
export function dismissNavBanner(): void {
  setBanner(null)
  requestAnimationFrame(() => {
    const a = document.activeElement
    if (a && a !== document.body) return
    const pane = document.querySelector<HTMLElement>('#main-content .settings-pane-title')
    focusHeading(pane ?? document.querySelector<HTMLElement>('#main-content h1'))
  })
}

type State = ReturnType<typeof useAppStore.getState>

/** Where the window is: the banner belongs to this place and goes when the user leaves it. */
export function locationKey(s: Pick<State, 'view' | 'selectedProjectId'>): string {
  return s.view === 'projects' || s.view === 'appSettings' ? s.view : `${s.selectedProjectId ?? ''}:${s.view}`
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

/** Focus `el` as a heading target (tabindex -1, no scroll). */
function focusHeading(el: HTMLElement | null | undefined): boolean {
  if (!el) return false
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
  return document.activeElement === el
}


/** Focus sits on a form control or button inside the main area (something a key press could change or press). */
function onControl(): boolean {
  const a = document.activeElement
  return !!a && !!document.getElementById('main-content')?.contains(a) && a.matches('input, select, textarea, button, [role=radio], [role=switch], [role=option], a[href]')
}

const isHeading = (el: Element | null): boolean => !!el && (/^H[1-6]$/.test(el.tagName) || el.classList.contains('settings-pane-title'))

/** The destination's heading: the target section's title, else the settings pane title, else the view's h1. */
function landOnHeading(t: NavTarget): void {
  const a = document.activeElement
  const sectionId = t.kind === 'app' ? t.target : t.kind === 'project' || t.kind === 'usage' ? t.section : undefined
  const section = sectionId ? document.getElementById(sectionId) : null
  const title = section?.querySelector<HTMLElement>('.settings-section-title, .settings-group-title, h2, h3')
  // A section destination lands on the section's own heading, even when the pane's title already has focus (UX M3, L5).
  if (title && title.checkVisibility?.() !== false && (title === a || focusHeading(title))) {
    bannerAnchor = title
    return
  }
  if (isHeading(a) && document.getElementById('main-content')?.contains(a)) {
    bannerAnchor = a as HTMLElement
    return
  }
  if ((t.kind === 'app' || (t.kind === 'project' && t.view === 'settings')) && document.querySelector('.settings-pane-title')) {
    focusPaneHeading({ preventScroll: true })
    if (isHeading(document.activeElement)) {
      bannerAnchor = document.activeElement as HTMLElement
      return
    }
  }
  focusHeading(document.querySelector<HTMLElement>('#main-content h1'))
  bannerAnchor = document.activeElement as HTMLElement | null
}

/** The heading the navigation landed on: Tab from it goes to the banner's actions, which sit above it in the DOM (UX M3). */
let bannerAnchor: HTMLElement | null = null
export const navBannerAnchor = (): HTMLElement | null => (bannerAnchor && bannerAnchor.isConnected ? bannerAnchor : null)

/** True when the run that asked has a decision card (a pending proposal) open. */
export function useChangeWaiting(runId: string | undefined): boolean {
  return useAppStore((s) => (runId ? (s.runs[runId]?.proposals.length ?? 0) > 0 : false))
}

async function perform(plan: Extract<NavigationPlan, { ok: true }>, event: AppNavigateEvent): Promise<void> {
  const st = useAppStore.getState()
  const t = plan.target
  const pid = plan.projectId
  switch (t.kind) {
    case 'usage':
      st.openUsage(t.section ? { section: t.section } : {})
      break
    case 'dashboard':
      st.setView('projects')
      if (t.newProject) openNewProject()
      break
    case 'app':
      requestAppSettingsSection(t.target)
      st.setView('appSettings')
      window.dispatchEvent(new Event('orgai:settings-section'))
      if (t.advanced) {
        await nextFrame()
        openSettingsAdvanced(t.advanced)
      }
      break
    case 'assistant':
      await st.openAssistant(t.id, { fresh: true })
      break
    case 'shell':
      if (t.what === 'shortcuts') openKeyboardShortcuts()
      break
    case 'run': {
      if (!pid) break
      if (isVirtualProjectId(pid)) await st.focusRun(pid, event.runId)
      else {
        await st.openProject(pid)
        useAppStore.getState().setView('run')
      }
      if (t.sideTab) useAppStore.getState().setSideTab(t.sideTab)
      if (t.composer) useAppStore.getState().focusComposer()
      break
    }
    case 'project': {
      if (!pid) break
      if (t.view === 'run') {
        await st.openProject(pid)
        useAppStore.getState().setView('run')
        if (t.draft) useAppStore.getState().openDraft()
        break
      }
      if (useAppStore.getState().selectedProjectId !== pid) useAppStore.getState().selectProject(pid)
      if (t.pane) useAppStore.getState().setProjectSettingsPane(pid, t.pane)
      useAppStore.getState().setView(t.view)
      if (t.section) requestProjectSettingsSection(t.section)
      if (t.advanced) {
        await nextFrame()
        openSettingsAdvanced(t.advanced)
      }
      break
    }
  }
  // Land focus on the destination's heading, never on a control: some deep links focus a setting (the checked canvas
  // style, the Team assistant select) where an arrow key would change it (review M1; coordinator: headings only).
  await nextFrame()
  await nextFrame()
  if (t.kind === 'shell') {
    if (t.what !== 'shortcuts') focusHeading(document.getElementById('sidebar'))
  } else if (!(t.kind === 'run' && t.composer)) {
    landOnHeading(t)
    // App settings focuses its target once its settings load; check again after that.
    await new Promise((r) => setTimeout(r, 400))
    if (onControl() || document.activeElement?.classList.contains('settings-pane-title')) landOnHeading(t)
  }
  // A part of a page (a Team or History section, a run part): bring its first element into view inside its scroller.
  if ((t.kind === 'project' && t.view !== 'settings') || (t.kind === 'usage' && t.section)) {
    for (const id of plan.testIds) {
      const el = document.querySelector(`[data-testid="${CSS.escape(id)}"]`)
      if (el) {
        scrollWithin(el, 'nearest')
        break
      }
    }
  }
}

/** Handles one event: plan, perform, banner, announcement. Exported for tests of the wiring. */
export async function handleAppNavigate(event: AppNavigateEvent): Promise<void> {
  const st = useAppStore.getState()
  const plan = navigationFor(event, { projects: st.projects, runProjectId: st.runs[event?.runId]?.summary.projectId })
  if (!plan.ok) {
    // Nothing moved: say it where the user is. On a run view the run tabs' notice is visible already (review L2);
    // elsewhere the banner shows it, without a way back.
    announceMenu(plan.message)
    if (!onRunView()) setBanner({ seq: ++seq, message: plan.message, home: locationKey(useAppStore.getState()) })
    return
  }
  try {
    await perform(plan, event)
  } catch (err) {
    console.warn('app navigate: could not open', event.surfaceId, err)
  }
  // The banner is not for the run that asked when the destination is that very run.
  const after = useAppStore.getState()
  const backTo = after.view === 'run' && after.selectedProjectId && after.activeRunByProject[after.selectedProjectId] === event.runId ? undefined : event.runId
  // Inside the asking run itself the run tabs' visible notice says it; a banner would repeat it (review L2).
  if (backTo || !onRunView()) setBanner({ seq: ++seq, message: plan.message, ...(backTo ? { runId: backTo } : {}), home: locationKey(after) })
  else setBanner(null)
  announceMenu(plan.message)
}

/** A run view with its run tabs on screen: announceMenu then shows the sentence there, visibly. */
function onRunView(): boolean {
  const s = useAppStore.getState()
  return s.view === 'run' && menuStateFor(s).hasProject
}

/** "Back to chat": the run that asked, in its project's Live view, with the composer focused. Clears the banner. */
export async function backToChat(runId: string): Promise<void> {
  setBanner(null)
  const st = useAppStore.getState()
  const projectId = st.runs[runId]?.summary.projectId ?? 'quick'
  await st.focusRun(projectId, runId)
  useAppStore.getState().focusComposer()
}

/** Installs the subscription once (AppMenuLayer); the banner clears when the user leaves its place. */
export function useAppNavigate(): void {
  useEffect(() => {
    let off: (() => void) | undefined
    try {
      off = window.orgai?.onAppNavigate?.((e) => void handleAppNavigate(e))
    } catch {
      off = undefined
    }
    const unsubscribeStore = useAppStore.subscribe((s) => {
      const b = banner
      if (b?.home && locationKey(s) !== b.home) setBanner(null)
    })
    return () => {
      off?.()
      unsubscribeStore()
    }
  }, [])
}
