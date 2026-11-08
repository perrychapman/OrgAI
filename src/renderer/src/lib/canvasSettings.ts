import type { AppearanceSettings, CanvasPresentation, CanvasScenePalette } from '@shared/types'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { setAppearance } from './theme'

/** Canvas settings are the `canvas` object of AppearanceSettings. */
export type CanvasSettings = AppearanceSettings['canvas']

export const PRESENTATION_OPTIONS: { value: CanvasPresentation; label: string }[] = [
  { value: 'graph', label: 'Graph' },
  { value: 'pocket-office', label: 'Pocket Office' }
]
export const SCENE_PALETTE_OPTIONS: { value: CanvasScenePalette; label: string }[] = [
  { value: 'color', label: 'Color' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'green', label: 'Green' }
]

/** Pure: "Canvas style: Blueprint." / "Canvas style: Custom." */
export function canvasAnnouncement(label: string | undefined): string {
  return `Canvas style: ${label ?? 'Custom'}.`
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Change the canvas appearance from outside the settings page (the toolbar popover): reads the saved settings, merges
 * the new canvas, applies it at once through setAppearance and saves it through settings:set (broadcast follows).
 * Calls are serialised so quick arrow presses never overwrite each other. The settings page does the same through its
 * own `patchAppearance` because it owns the debounced save of the whole settings object.
 */
export function saveCanvas(change: (canvas: CanvasSettings) => CanvasSettings): Promise<void> {
  const run = async (): Promise<void> => {
    const info = await window.orgai.settings.get()
    const { dataDir: _dataDir, appVersion: _appVersion, ...settings } = info
    const appearance: AppearanceSettings = settings.appearance ?? DEFAULT_APPEARANCE
    const next: AppearanceSettings = { ...appearance, canvas: change({ ...appearance.canvas }) }
    setAppearance(next)
    await window.orgai.settings.set({ ...settings, appearance: next })
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
