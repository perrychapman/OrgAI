import { newRunDraftKey, useAppStore } from '../../store/useAppStore'
import { mergeDraftText } from '../../lib/projectHome'

/**
 * Opens the project's New run page with `text` in its message box. Nothing is sent: the user starts the run there, with
 * the run settings in view. An unsent draft already in the box is kept: `text` is added after it on a new line, unless it
 * is the draft itself.
 *
 * `mode` is a one-shot for this opening (store `newRunMode`): the page opens in it, reads it once and clears it, and the
 * user's own sticky Team / Ask choice in storage is never touched.
 */
export function openNewRunWith(projectId: string, text: string, mode?: 'team' | 'ask'): void {
  const st = useAppStore.getState()
  if (st.selectedProjectId !== projectId) st.selectProject(projectId)
  const key = newRunDraftKey(projectId)
  const before = useAppStore.getState().composerDrafts[key]
  const next = mergeDraftText(before?.text ?? '', text)
  if (next !== (before?.text ?? '') || before) useAppStore.getState().setComposerDraft(key, { text: next, images: before?.images ?? [] })
  useAppStore.getState().setNewRunMode(projectId, mode ?? null)
  useAppStore.getState().openDraft()
  requestAnimationFrame(() => requestAnimationFrame(() => useAppStore.getState().focusComposer()))
}
