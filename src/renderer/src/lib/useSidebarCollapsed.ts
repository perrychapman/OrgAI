import { useSyncExternalStore } from 'react'

const KEY = 'orgai.sidebar'
/** Below this window width the sidebar is a 56 px rail unless the user chose otherwise. */
export const RAIL_BELOW_PX = 1180

type Choice = 'collapsed' | 'expanded' | null

/** Pure: an explicit choice wins, otherwise the window width decides. */
export function resolveCollapsed(choice: Choice, width: number): boolean {
  if (choice === 'collapsed') return true
  if (choice === 'expanded') return false
  return width < RAIL_BELOW_PX
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
const listeners = new Set<() => void>()
const width = (): number => (typeof window === 'undefined' ? 1440 : window.innerWidth)
const emit = (): void => listeners.forEach((l) => l())

const snapshot = (): boolean => resolveCollapsed(choice, width())

function subscribe(l: () => void): () => void {
  listeners.add(l)
  window.addEventListener('resize', l)
  return () => {
    listeners.delete(l)
    window.removeEventListener('resize', l)
  }
}

export function setSidebarCollapsed(next: boolean): void {
  choice = next ? 'collapsed' : 'expanded'
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
  emit()
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!snapshot())
}

/** Sidebar rail state shared by App (grid column, Ctrl/Cmd+B) and Sidebar (content). Persisted in localStorage. */
export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void; setCollapsed: (v: boolean) => void } {
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => false)
  return { collapsed, toggle: toggleSidebar, setCollapsed: setSidebarCollapsed }
}
