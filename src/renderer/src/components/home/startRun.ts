import { newRunDraftKey, useAppStore } from '../../store/useAppStore'
import { mergeDraftText } from '../../lib/projectHome'

/** Where NewRunPage keeps its Team / Ask choice per project (NewRunPage.tsx `newRunModeKey`); Home writes it before opening the page. */
export const newRunModeStorageKey = (projectId: string): string => `orgai.newRunMode.${projectId}`

/** How long the lent mode stays in storage at most (the page mounts and reads it within a few frames). */
const LEND_MAX_MS = 1500
/** Settle time after the composer shows: the page re-reads the mode in an effect right after its first commit. */
const LEND_SETTLE_MS = 300

/**
 * Writes `mode` as the project's New run mode for the page about to mount, then restores what was stored before (or
 * removes the key) once the page has read it, so choosing "One assistant" here never changes the sticky Team / Ask mode.
 * The restore leaves a value alone that someone else changed meanwhile (the user toggled on the page).
 */
function lendMode(projectId: string, mode: 'team' | 'ask'): void {
  const key = newRunModeStorageKey(projectId)
  let before: string | null
  try {
    before = localStorage.getItem(key)
    localStorage.setItem(key, mode)
  } catch {
    return // storage unavailable: the page opens in its last mode
  }
  const restore = (): void => {
    try {
      if (localStorage.getItem(key) !== mode) return
      if (before === null) localStorage.removeItem(key)
      else localStorage.setItem(key, before)
    } catch {
      /* storage unavailable */
    }
  }
  const started = Date.now()
  const wait = (): void => {
    if (document.querySelector('.composer textarea') || Date.now() - started > LEND_MAX_MS) window.setTimeout(restore, LEND_SETTLE_MS)
    else requestAnimationFrame(wait)
  }
  requestAnimationFrame(wait)
}

/**
 * Opens the project's New run page with `text` in its message box. Nothing is sent: the user starts the run there, with
 * the run settings in view. An unsent draft already in the box is kept: `text` is added after it on a new line, unless it
 * is the draft itself.
 */
export function openNewRunWith(projectId: string, text: string, mode?: 'team' | 'ask'): void {
  const st = useAppStore.getState()
  if (st.selectedProjectId !== projectId) st.selectProject(projectId)
  const key = newRunDraftKey(projectId)
  const before = useAppStore.getState().composerDrafts[key]
  const next = mergeDraftText(before?.text ?? '', text)
  if (next !== (before?.text ?? '') || before) useAppStore.getState().setComposerDraft(key, { text: next, images: before?.images ?? [] })
  // The mode is a one-shot for this opening: NewRunPage only reads its sticky mode from storage when it mounts, and has
  // no prop for it, so the choice is lent to that read and the user's own sticky mode is put back right after.
  if (mode) lendMode(projectId, mode)
  useAppStore.getState().openDraft()
  requestAnimationFrame(() => requestAnimationFrame(() => useAppStore.getState().focusComposer()))
}
