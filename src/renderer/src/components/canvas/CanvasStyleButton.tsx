import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import { Palette } from 'lucide-react'
import { applyCanvasStyle, styleLabel, useCanvasOptions, type CanvasStyleId } from '../../lib/canvas'
import { canvasAnnouncement, saveCanvas, PRESENTATION_OPTIONS, SCENE_PALETTE_OPTIONS } from '../../lib/canvasSettings'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { useFrameAnnounce } from '../layout/CanvasFrame'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { SegmentedControl } from '../ui/SegmentedControl'
import '../../styles/canvas-settings.css'
import { CanvasPresetGroup, focusCheckedPreset } from './CanvasPresetGroup'

function StylePanel({ close }: { close: () => void }): ReactElement {
  const canvas = useCanvasOptions()
  const announce = useFrameAnnounce()
  const root = useRef<HTMLDivElement>(null)

  // The panel is hidden until the popover has placed it, and the popover then focuses its first button: land on the
  // checked option a few times over the first moments instead.
  useEffect(() => {
    const timers = [0, 60, 160].map((ms) =>
      setTimeout(() => {
        const active = document.activeElement
        if (!root.current?.contains(active) || active?.getAttribute('role') === 'radio') focusCheckedPreset(root.current)
      }, ms)
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  const pick = (id: CanvasStyleId): void => {
    void saveCanvas((c) => applyCanvasStyle(c, id)).catch(() => undefined)
    announce?.(canvasAnnouncement(styleLabel(id)))
  }

  return (
    <div className="canvas-style-popover-body" ref={root}>
      <h3 className="canvas-style-popover-heading">Canvas style</h3>
      <div data-testid="canvas-presentation">
        <SegmentedControl label="Canvas presentation" value={canvas.presentation} options={PRESENTATION_OPTIONS} onChange={(presentation) => {
          void saveCanvas((c) => ({ ...c, presentation })).catch(() => undefined)
          announce?.(`Canvas presentation: ${presentation === 'graph' ? 'Graph' : 'Pocket Office'}.`)
        }} />
      </div>
      <div data-testid="canvas-scene-palette">
        <SegmentedControl label="Office palette" value={canvas.scenePalette} options={SCENE_PALETTE_OPTIONS} onChange={(scenePalette) => {
          void saveCanvas((c) => ({ ...c, scenePalette })).catch(() => undefined)
          announce?.(`Office palette: ${scenePalette === 'neutral' ? 'Neutral' : 'Green'}.`)
        }} />
      </div>
      <CanvasPresetGroup canvas={canvas} onPick={pick} variant="compact" />
      <div className="canvas-style-popover-foot">
        <Button
          variant="ghost"
          size="sm"
          testId="canvas-style-more"
          onClick={() => {
            close()
            requestAppSettingsSection(APP_SETTINGS_SECTIONS.canvas)
            useAppStore.getState().setView('appSettings')
          }}
        >
          More canvas settings
        </Button>
      </div>
    </div>
  )
}

/**
 * "Canvas style" button for the Live run and Team canvas toolbars: a popover with the style presets (picked and applied
 * at once) and a link to App settings > General > Canvas (docs/design/canvas-themes.md 7.2).
 */
export function CanvasStyleButton({ testId }: { testId?: string }): ReactElement {
  return (
    <Popover
      label="Canvas style"
      placement="bottom-end"
      triggerClassName="icon-btn size-sm"
      triggerLabel="Canvas style"
      triggerTitle="Canvas style"
      trigger={<Icon icon={Palette} size="sm" />}
      testId="canvas-style-popover"
      triggerTestId={testId}
    >
      {({ close }) => <StylePanel close={close} />}
    </Popover>
  )
}
