import { useSyncExternalStore } from 'react'
import { beginLayoutMotion } from './layoutMotion'
import { tokenMs } from './useExitPresence'

const KEY = 'orgai.sidebar'
/** Below this window width the sidebar is a 56 px rail unless the user chose otherwise. */
export const RAIL_BELOW_PX = 1180

type Choice = 'collapsed' | 'expanded' | null
/** A user toggle in flight (docs/design/motion.md 3.5); null at rest, on first layout and on the 1180 px breakpoint. */
export type SidebarMotion = 'expanding' | 'collapsing' | null

/** Pure: an explicit choice wins, otherwise the window width decides. */
export function resolveCollapsed(choice: Choice, width: number): boolean {
  if (choice === 'collapsed') return true
  if (choice === 'expanded') return false
  return width < RAIL_BELOW_PX
}

/**
 * Pure: whether the sidebar's content is drawn as the rail. A collapse keeps the full content (clipped, fixed width)
 * until the column has arrived, so labels never wrap or jump while the column narrows; an expand draws the full content
 * at once.
 */
export function contentIsRail(collapsed: boolean, motion: SidebarMotion): boolean {
  return collapsed && motion !== 'collapsing'
}

function readChoice(): Choice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'collapsed' || v === 'expanded' ? v : null
  } catch {
    return null
  }
}

let choice: Choice = readChoice()
let motion: SidebarMotion = null
let motionTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const width = (): number => (typeof window === 'undefined' ? 1440 : window.innerWidth)
const emit = (): void => listeners.forEach((l) => l())

const snapshot = (): boolean => resolveCollapsed(choice, width())
const motionSnapshot = (): SidebarMotion => motion

function subscribe(l: () => void): () => void {
  listeners.add(l)
  window.addEventListener('resize', l)
  return () => {
    listeners.delete(l)
    window.removeEventListener('resize', l)
  }
}

/** Starts the glide for a user toggle. Under reduced motion (token 0) nothing moves and no state is kept. */
function beginSidebarMotion(next: boolean): void {
  const ms = tokenMs('--dur-slow')
  if (!(ms > 0)) return
  motion = next ? 'collapsing' : 'expanding'
  beginLayoutMotion(ms)
  if (motionTimer !== undefined) clearTimeout(motionTimer)
  motionTimer = setTimeout(() => {
    motionTimer = undefined
    motion = null
    emit()
  }, ms + 20)
}

export function setSidebarCollapsed(next: boolean): void {
  const was = snapshot()
  choice = next ? 'collapsed' : 'expanded'
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
  if (was !== next) beginSidebarMotion(next)
  emit()
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!snapshot())
}

/** Sidebar rail state shared by App (grid column, Ctrl/Cmd+B) and Sidebar (content). Persisted in localStorage. */
export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void; setCollapsed: (v: boolean) => void; motion: SidebarMotion } {
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => false)
  const moving = useSyncExternalStore(subscribe, motionSnapshot, () => null)
  return { collapsed, toggle: toggleSidebar, setCollapsed: setSidebarCollapsed, motion: moving }
}
