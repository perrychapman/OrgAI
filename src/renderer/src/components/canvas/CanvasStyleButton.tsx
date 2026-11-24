import type { ReactElement, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Palette } from 'lucide-react'
import { applyCanvasStyle, isScenePresentation, shownStyle, styleLabel, useCanvasOptions, usesScenePalette, type CanvasStyleId } from '../../lib/canvas'
import { canvasAnnouncement, presentationLabel, saveCanvas, SCENE_PALETTE_OPTIONS } from '../../lib/canvasSettings'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { useFrameAnnounce } from '../layout/CanvasFrame'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import '../../styles/canvas-settings.css'
import { CanvasPresetGroup } from './CanvasPresetGroup'
import { CanvasPresentationChoices } from './CanvasPresentationChoices'

/** The View menu's one-row form of the graph styles: the current style's name, and the radio group below once opened. */
function StyleDisclosure({ canvas, onPick }: { canvas: ReturnType<typeof useCanvasOptions>; onPick: (id: CanvasStyleId) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const id = useId()
  const shown = shownStyle(canvas)
  return (
    <div className="view-styles">
      <button type="button" className="view-legend-trigger" data-testid="canvas-style-disclosure" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Icon icon={Palette} size="sm" />
        <span>Canvas style</span>
        <span className="view-styles-current">{(shown && styleLabel(shown)) ?? 'Custom'}</span>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
      </button>
      {open && (
        <div id={id}>
          <p>Applies across the app, including Live and Team.</p>
          <CanvasPresetGroup canvas={canvas} onPick={onPick} variant="compact" label="Graph style" />
        </div>
      )}
    </div>
  )
}

/**
 * The body of the style popover. The Live run's View menu (CanvasViewMenu) reuses it: `heading` renames it, `lead` adds
 * the view options above the style choices and `tail` adds the legend below them.
 */
export function StylePanel({ close, withPresentation, heading = 'Canvas style', lead, tail, foldStyles = false }: { close: () => void; withPresentation: boolean; heading?: string; lead?: ReactNode; tail?: ReactNode; foldStyles?: boolean }): ReactElement {
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
      // With view options above (the Live View menu) focus starts on the first of them, not on the palette below.
      if (lead) return
      root.current?.querySelector<HTMLInputElement>('[data-testid="canvas-presentation"] input:checked, [data-testid="canvas-scene-palette"] input:checked')?.focus()
    }}>
      <h3 className="canvas-style-popover-heading">{heading}</h3>
      {lead}
      {foldStyles && usesScenePalette(canvas.presentation) && <h4>Canvas style</h4>}
      <CanvasPresentationChoices hidePresentation={!withPresentation} canvas={canvas} onPresentation={(presentation) => {
        void saveCanvas((c) => ({ ...c, presentation })).then(() => announce?.(`Canvas presentation: ${presentationLabel(presentation)}.`), () => announce?.('Could not save canvas presentation.'))
      }} onPalette={(scenePalette) => {
        void saveCanvas((c) => ({ ...c, scenePalette })).then(() => announce?.(`Office palette: ${SCENE_PALETTE_OPTIONS.find(option => option.value === scenePalette)?.label}.`), () => announce?.('Could not save office palette.'))
      }} />
      {/* In the Live View menu the seven graph styles fold behind one row (a menu of 450 px would cover the minimap and scroll at 640 px). */}
      {!isScenePresentation(canvas.presentation) && foldStyles && <StyleDisclosure canvas={canvas} onPick={pick} />}
      {(!foldStyles || isScenePresentation(canvas.presentation)) && <p>Applies across the app, including Live and Team.</p>}
      {!isScenePresentation(canvas.presentation) && !foldStyles && <><h4>Graph styles</h4><CanvasPresetGroup canvas={canvas} onPick={pick} variant="compact" label="Graph style" /></>}
      {tail}
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
 * at once) and a link to App settings > General > Canvas (docs/design/canvas-themes.md 7.2). It also offers the
 * presentation radio group unless `withPresentation` is false: pass false wherever CanvasThemeMenu sits beside it, so
 * the presentation is chosen in one place only.
 */
export function CanvasStyleButton({ testId, withPresentation = true }: { testId?: string; withPresentation?: boolean }): ReactElement {
  return (
    <Popover
      label="Canvas style"
      placement="bottom-start"
      triggerClassName="btn ghost sm canvas-style-trigger"
      triggerLabel="Canvas style"
      triggerTitle="Canvas style"
      trigger={<><Icon icon={Palette} size="sm" /><span>Canvas style</span></>}
      testId="canvas-style-popover"
      triggerTestId={testId}
    >
      {({ close }) => <StylePanel close={close} withPresentation={withPresentation} />}
    </Popover>
  )
}
