import type { ReactElement } from 'react'
import { useId, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { CanvasEdgeStyle, CanvasLayout, CanvasNodeStyle, CanvasPattern } from '@shared/types'
import { CANVAS_PATTERNS } from '@shared/types'
import { AVAILABLE_NODE_STYLES, applyCanvasStyle, effectiveNodeStyle, shownStyle, styleLabel, type CanvasStyleId } from '../../lib/canvas'
import { canvasAnnouncement, PRESENTATION_OPTIONS, SCENE_PALETTE_OPTIONS, type CanvasSettings } from '../../lib/canvasSettings'
import { CanvasPresetGroup } from '../canvas/CanvasPresetGroup'
import { CanvasPreview } from '../canvas/CanvasPreview'
import { Icon } from '../ui/Icon'
import { SegmentedControl } from '../ui/SegmentedControl'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'
import '../../styles/canvas-settings.css'

export const CANVAS_SECTION_ID = 'appsettings-section-canvas'
const CUSTOMISE_KEY = 'orgai.canvasCustomise'

const PATTERN_LABEL: Record<CanvasPattern, string> = {
  dots: 'Dots',
  grid: 'Grid',
  none: 'None',
  blueprint: 'Blueprint',
  paper: 'Paper',
  isometric: 'Isometric',
  circuit: 'Circuit',
  terminal: 'Terminal',
  starfield: 'Starfield'
}
const LAYOUT_OPTIONS: { value: CanvasLayout; label: string }[] = [
  { value: 'top-down', label: 'Top down' },
  { value: 'left-right', label: 'Left to right' },
  { value: 'radial', label: 'Radial' }
]
const EDGE_OPTIONS: { value: CanvasEdgeStyle; label: string }[] = [
  { value: 'curved', label: 'Curved' },
  { value: 'orthogonal', label: 'Right angle' },
  { value: 'straight', label: 'Straight' }
]
const NODE_STYLE_LABEL: Partial<Record<CanvasNodeStyle, string>> = { card: 'Cards', compact: 'Name tags', station: 'Stations', hex: 'Honeycomb' }

function readOpen(): boolean | null {
  try {
    const v = localStorage.getItem(CUSTOMISE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/**
 * App settings > General > Canvas: a live preview, the style gallery and a Customise disclosure
 * (docs/design/canvas-themes.md 7.1). `canvas` is the saved setting; `onChange` applies and saves a whole new canvas.
 * Test ids: `canvas-section`, `canvas-preset`, `canvas-customise` (the button), `canvas-backdrop-select` (the select
 * itself), `canvas-layout` / `canvas-edges` / `canvas-node-style` (a wrapper around the radio group), `canvas-tint`
 * and `canvas-minimap` (the switches), `canvas-preview`, `canvas-announce`.
 */
export function CanvasSection({ canvas, onChange }: { canvas: CanvasSettings; onChange: (next: CanvasSettings) => void }): ReactElement {
  const bodyId = useId()
  const [open, setOpen] = useState<boolean>(() => readOpen() ?? shownStyle(canvas) === undefined)
  const [said, setSaid] = useState('')
  const groupRef = useRef<HTMLDivElement>(null)

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(CUSTOMISE_KEY, next ? '1' : '0')
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
  }
  const labelOf = (c: CanvasSettings): string | undefined => styleLabel(shownStyle(c))
  const pick = (id: CanvasStyleId): void => {
    const next = applyCanvasStyle(canvas, id)
    onChange(next)
    setSaid(canvasAnnouncement(labelOf(next)))
  }
  const change = (patch: Partial<CanvasSettings>): void => {
    const next: CanvasSettings = { ...canvas, ...patch }
    onChange(next)
    // Only a change that moves between a preset and Custom (or between presets) is a style change worth saying.
    if (labelOf(next) !== labelOf(canvas)) setSaid(canvasAnnouncement(labelOf(next)))
  }
  const styleOptions = AVAILABLE_NODE_STYLES.map((s) => ({ value: s, label: NODE_STYLE_LABEL[s] ?? s }))

  return (
    <SettingsSection
      id={CANVAS_SECTION_ID}
      title="Canvas"
      description="Applies to Live, Team and the sample preview."
      testId="canvas-section"
    >
      <div className="canvas-section">
        <SettingsCard>
          <SettingRow title="Presentation" description="Choose how agents appear on the canvas." width="select" control={
            <div data-testid="canvas-presentation"><SegmentedControl label="Presentation" value={canvas.presentation ?? 'graph'} options={PRESENTATION_OPTIONS} onChange={(presentation) => change({ presentation })} /></div>
          } />
          {canvas.presentation === 'pocket-office' && <SettingRow title="Office palette" description="Choose the colours of the Pocket Office scene." width="select" control={
            <div data-testid="canvas-scene-palette"><SegmentedControl label="Office palette" value={canvas.scenePalette ?? 'color'} options={SCENE_PALETTE_OPTIONS} onChange={(scenePalette) => change({ scenePalette })} /></div>
          } />}
        </SettingsCard>
        <div className="canvas-section-body">
          <div className="canvas-section-preview">
            <CanvasPreview />
          </div>
          <div className="canvas-section-main">
            <p>Choose a graph style to switch to Graph.</p>
            <CanvasPresetGroup canvas={canvas} onPick={pick} variant="gallery" groupRef={groupRef} label="Graph style" />
            <div className="canvas-customise">
              <button type="button" className="canvas-customise-toggle" data-testid="canvas-customise" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
                <span className="canvas-customise-chevron">
                  <Icon icon={ChevronRight} size="sm" />
                </span>
                Customise
              </button>
              <div id={bodyId} className="motion-collapse" data-collapsed={open ? 'false' : 'true'}>
                <div>
                  <SettingsCard>
                    <SettingRow
                      id="canvas-backdrop-row"
                      title="Background"
                      description="The pattern behind your agents. It moves and zooms with the canvas."
                      width="select"
                      control={
                        <select
                          className="select"
                          aria-label="Background"
                          aria-describedby={settingDescId('canvas-backdrop-row')}
                          value={canvas.pattern}
                          data-testid="canvas-backdrop-select"
                          onChange={(e) => change({ pattern: e.target.value as CanvasPattern })}
                        >
                          {CANVAS_PATTERNS.map((p) => (
                            <option key={p} value={p}>
                              {PATTERN_LABEL[p]}
                            </option>
                          ))}
                        </select>
                      }
                    />
                    <SettingRow
                      title="Layout"
                      description="Where each agent sits around the one it reports to."
                      width="select"
                      control={
                        <div data-testid="canvas-layout">
                          <SegmentedControl label="Layout" value={canvas.layout} options={LAYOUT_OPTIONS} onChange={(layout) => change({ layout })} />
                        </div>
                      }
                    />
                    <SettingRow
                      title="Lines"
                      description="How reporting lines are drawn. In the radial layout, right angles draw straight."
                      width="select"
                      control={
                        <div data-testid="canvas-edges">
                          <SegmentedControl label="Lines" value={canvas.edges} options={EDGE_OPTIONS} onChange={(edges) => change({ edges })} />
                        </div>
                      }
                    />
                    {styleOptions.length > 1 && (
                      <SettingRow
                        title="Agents as"
                        description="Name tags, stations and honeycomb tiles fit more agents. Activity and tokens move to the tooltip and side panel."
                        width="select"
                        control={
                          <div data-testid="canvas-node-style">
                            <SegmentedControl label="Agents as" value={effectiveNodeStyle(canvas.nodeStyle)} options={styleOptions} onChange={(nodeStyle) => change({ nodeStyle })} />
                          </div>
                        }
                      />
                    )}
                    <SettingRow
                      id="canvas-tint-row"
                      title="Accent tint"
                      description="A soft wash of your accent colour at the top of the canvas."
                      control={<Switch checked={canvas.tint} label="Accent tint" testId="canvas-tint" describedBy={settingDescId('canvas-tint-row')} onChange={(tint) => change({ tint })} />}
                    />
                    <SettingRow
                      id="canvas-minimap-row"
                      title="Minimap"
                      description="A small map of the whole chart in a corner. Hidden when the canvas is short."
                      control={<Switch checked={canvas.minimap} label="Minimap" testId="canvas-minimap" describedBy={settingDescId('canvas-minimap-row')} onChange={(minimap) => change({ minimap })} />}
                    />
                  </SettingsCard>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p className="sr-only" role="status" aria-live="polite" data-testid="canvas-announce">
          {said}
        </p>
      </div>
    </SettingsSection>
  )
}
