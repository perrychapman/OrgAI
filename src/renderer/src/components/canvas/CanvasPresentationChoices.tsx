import { useId, type CSSProperties, type ReactElement } from 'react'
import type { CanvasPresentation, CanvasScenePalette } from '@shared/types'
import { Check } from 'lucide-react'
import { PRESENTATION_OPTIONS, SCENE_PALETTE_OPTIONS, type CanvasSettings } from '../../lib/canvasSettings'
import atlas from '../../assets/pocket-office/atlas.json'
import tilesColor from '../../assets/pocket-office/tiles-color.png'
import tilesNeutral from '../../assets/pocket-office/tiles-neutral.png'
import tilesGreen from '../../assets/pocket-office/tiles-green.png'
import propsColor from '../../assets/pocket-office/props-color.png'
import propsNeutral from '../../assets/pocket-office/props-neutral.png'
import propsGreen from '../../assets/pocket-office/props-green.png'
import workersColor from '../../assets/pocket-office/workers-color.png'
import workersNeutral from '../../assets/pocket-office/workers-neutral.png'
import workersGreen from '../../assets/pocket-office/workers-green.png'
import { Icon } from '../ui/Icon'
import { CanvasThumb } from './CanvasThumb'

const sheets = {
  color: [tilesColor, propsColor, workersColor],
  neutral: [tilesNeutral, propsNeutral, workersNeutral],
  green: [tilesGreen, propsGreen, workersGreen]
}

function OfficeThumb({ palette }: { palette: CanvasScenePalette }): ReactElement {
  const sprite = (sheet: string, frame: { x: number; y: number; w: number; h: number }): CSSProperties => ({
    width: frame.w, height: frame.h, backgroundImage: `url(${sheet})`, backgroundPosition: `-${frame.x}px -${frame.y}px`
  })
  const [tiles, props, workers] = sheets[palette]
  return <span className="canvas-office-thumb" aria-hidden="true" style={{ backgroundImage: `url(${tiles})` }}>
    <span className="canvas-office-thumb-desk" style={sprite(props, atlas.sheets.props.frames['prop.desk'])} />
    <span className="canvas-office-thumb-person" style={sprite(workers, atlas.sheets.workers.frames['worker.crop.down.idle'])} />
  </span>
}

/** A deliberately framed, inert room rather than a cropped viewport of the live building. */
export function OfficeSample({ palette }: { palette: CanvasScenePalette }): ReactElement {
  const [tiles, props, workers] = sheets[palette]
  const frameStyle = (sheet: string, frame: { x: number; y: number; w: number; h: number }, left: number, top: number): CSSProperties => ({
    left, top, width: frame.w, height: frame.h, backgroundImage: `url(${sheet})`, backgroundPosition: `-${frame.x}px -${frame.y}px`
  })
  const furnishings = [['window', 96, 12], ['shelf', 16, 16], ['desk', 40, 48], ['chair', 72, 48], ['crt', 40, 48], ['sofa', 112, 56], ['plant', 16, 64]] as const
  return <div className="office-scene office-sample" data-testid="office-scene" data-mode="sample" data-palette={palette}>
    <p>Sample office · example agents</p>
    <div className="office-sample-frame" aria-hidden="true"><div className="office-sample-art">
      {Array.from({ length: 60 }, (_, i) => <i key={i} style={frameStyle(tiles, atlas.sheets.tiles.frames[i < 10 || i % 10 === 0 || i % 10 === 9 ? 'tile.08' : 'tile.00'], i % 10 * 16, Math.floor(i / 10) * 16)} />)}
      {furnishings.map(([name, x, y]) => <i key={name} style={frameStyle(props, atlas.sheets.props.frames[`prop.${name}`], x, y)} />)}
      <i style={frameStyle(workers, atlas.sheets.workers.frames['worker.crop.down.idle'], 67, 67)} />
    </div></div>
    <p className="office-sample-label">Alex · Sample</p>
  </div>
}

export function CanvasPresentationChoices({ canvas, onPresentation, onPalette }: {
  canvas: CanvasSettings
  onPresentation: (value: CanvasPresentation) => void
  onPalette: (value: CanvasScenePalette) => void
}): ReactElement {
  const presentationName = useId()
  const paletteName = useId()
  const presentation = canvas.presentation ?? 'graph'
  const palette = canvas.scenePalette ?? 'color'
  return <div className="canvas-choice-groups">
    <fieldset className="canvas-choice-group" data-testid="canvas-presentation">
      <legend>Presentation</legend>
      <div className="canvas-choices">
        {PRESENTATION_OPTIONS.map(option => <label className="canvas-choice" key={option.value} data-testid="canvas-presentation-choice" data-presentation={option.value}>
          <input type="radio" data-testid={`canvas-presentation-${option.value}`} name={presentationName} value={option.value} checked={presentation === option.value} onChange={() => onPresentation(option.value)} />
          {option.value === 'graph' ? <CanvasThumb spec={canvas} /> : <OfficeThumb palette={palette} />}
          <span><strong>{option.label}</strong><span className="canvas-choice-description">{option.value === 'graph' ? 'A connected view of your team' : 'A spatial view of your team'}</span></span>
          {presentation === option.value && <span className="canvas-choice-check" aria-hidden="true"><Icon icon={Check} size="sm" /></span>}
        </label>)}
      </div>
    </fieldset>
    {presentation === 'pocket-office' && <fieldset className="canvas-choice-group" data-testid="canvas-scene-palette">
      <legend>Office palette</legend>
      <div className="canvas-choices canvas-palette-choices">
        {SCENE_PALETTE_OPTIONS.map(option => <label className="canvas-choice" key={option.value} data-testid="canvas-palette-choice" data-palette={option.value}>
          <input type="radio" data-testid={`canvas-office-palette-${option.value}`} name={paletteName} value={option.value} checked={palette === option.value} onChange={() => onPalette(option.value)} />
          <OfficeThumb palette={option.value} />
          <strong>{option.label}</strong>
          {palette === option.value && <span className="canvas-choice-check" aria-hidden="true"><Icon icon={Check} size="sm" /></span>}
        </label>)}
      </div>
    </fieldset>}
  </div>
}
