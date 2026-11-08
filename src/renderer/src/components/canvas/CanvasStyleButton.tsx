import type { ReactElement } from 'react'
import { useRef } from 'react'
import { Palette } from 'lucide-react'
import { applyCanvasStyle, styleLabel, useCanvasOptions, type CanvasStyleId } from '../../lib/canvas'
import { canvasAnnouncement, saveCanvas, SCENE_PALETTE_OPTIONS } from '../../lib/canvasSettings'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { useFrameAnnounce } from '../layout/CanvasFrame'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import '../../styles/canvas-settings.css'
import { CanvasPresetGroup } from './CanvasPresetGroup'
import { CanvasPresentationChoices } from './CanvasPresentationChoices'

function StylePanel({ close }: { close: () => void }): ReactElement {
  const canvas = useCanvasOptions()
  const announce = useFrameAnnounce()
  const root = useRef<HTMLDivElement>(null)
  const focused = useRef(false)

  const pick = (id: CanvasStyleId): void => {
    void saveCanvas((c) => applyCanvasStyle(c, id)).then(() => announce?.(canvasAnnouncement(styleLabel(id))), () => announce?.('Could not save canvas style.'))
  }

  return (
    <div className="canvas-style-popover-body" ref={root} onFocusCapture={() => {
      // Popover moves focus after placement. Redirect only that first entry, never later user navigation.
      if (focused.current) return
      focused.current = true
      root.current?.querySelector<HTMLInputElement>('[data-testid="canvas-presentation"] input:checked')?.focus()
    }}>
      <h3 className="canvas-style-popover-heading">Canvas style</h3>
      <CanvasPresentationChoices canvas={canvas} onPresentation={(presentation) => {
        void saveCanvas((c) => ({ ...c, presentation })).then(() => announce?.(`Canvas presentation: ${presentation === 'graph' ? 'Graph' : 'Pocket Office'}.`), () => announce?.('Could not save canvas presentation.'))
      }} onPalette={(scenePalette) => {
        void saveCanvas((c) => ({ ...c, scenePalette })).then(() => announce?.(`Office palette: ${SCENE_PALETTE_OPTIONS.find(option => option.value === scenePalette)?.label}.`), () => announce?.('Could not save office palette.'))
      }} />
      <p>Applies across the app, including Live and Team.</p>
      {canvas.presentation !== 'pocket-office' && <><h4>Graph styles</h4><CanvasPresetGroup canvas={canvas} onPick={pick} variant="compact" label="Graph style" /></>}
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
      triggerClassName="btn ghost sm canvas-style-trigger"
      triggerLabel="Canvas style"
      triggerTitle="Canvas style"
      trigger={<><Icon icon={Palette} size="sm" /><span>Canvas style</span></>}
      testId="canvas-style-popover"
      triggerTestId={testId}
    >
      {({ close }) => <StylePanel close={close} />}
    </Popover>
  )
}
