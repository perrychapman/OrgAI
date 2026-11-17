import { create } from 'zustand'
import type { UpdateActionResult, UpdateState } from '@shared/types'

/**
 * The renderer's one copy of the desktop updater state (docs/agent-notes/updates.md "Renderer"). `ensureUpdates()`
 * loads `updates.get()` once and subscribes to `onUpdatesChanged`; every later state comes from main's pushes (no
 * polling). The actions only forward to main and return its answer; the UI decides what to say about a refusal
 * (lib/updates.ts). `dismissedVersion` hides the sidebar notice for one version for this session (memory only).
 */
interface UpdatesStore {
  state: UpdateState | null
  dismissedVersion: string | null
  /**
   * Set (Date.now()) by the menu's Check for Updates… and the sidebar notice; the Updates block lands focus on its
   * heading and clears it (0). A request older than a few seconds is dropped there, so a later visit never jumps.
   */
  focusRequest: number
  dismiss(version: string): void
  requestFocus(): void
  clearFocusRequest(): void
}

export const useUpdatesStore = create<UpdatesStore>((set) => ({
  state: null,
  dismissedVersion: null,
  focusRequest: 0,
  dismiss: (version) => set({ dismissedVersion: version }),
  requestFocus: () => set((s) => ({ focusRequest: Math.max(Date.now(), s.focusRequest + 1) })),
  clearFocusRequest: () => set({ focusRequest: 0 })
}))

let started = false

/** Load once and follow main's pushes for the life of the window. Safe to call from every component that needs it. */
export function ensureUpdates(): void {
  if (started) return
  const api = typeof window !== 'undefined' ? window.orgai?.updates : undefined
  if (!api) return
  started = true
  // A push that lands before the first get() wins over it (it is newer).
  let pushed = false
  const unsubscribe = window.orgai.onUpdatesChanged?.((state) => {
    pushed = true
    useUpdatesStore.setState({ state })
  })
  api
    .get()
    .then((state) => {
      if (!pushed) useUpdatesStore.setState({ state })
    })
    .catch((err: unknown) => {
      // Leave a way back: the next component that mounts tries again (pushes keep arriving meanwhile).
      unsubscribe?.()
      started = false
      console.warn('updates: could not read the updater state', err)
    })
}

/**
 * updates.check(). Its answer is not written to the store: every change also arrives as a push, and an answer could
 * be older than a push that overtook it. With capability 'none' nothing changes, so nothing is lost.
 */
export async function checkForUpdates(): Promise<void> {
  await window.orgai.updates.check()
}

export const downloadUpdate = (): Promise<UpdateActionResult> => window.orgai.updates.download()

/** Never call with `force` unless the user confirmed ending the live runs (UpdatesSection's confirmation). */
export const installUpdate = (force?: true): Promise<UpdateActionResult> => window.orgai.updates.install(force ? { force: true } : undefined)

export const openReleasePage = (): Promise<void> => window.orgai.updates.openReleasePage()
