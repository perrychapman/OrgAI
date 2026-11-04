import { useId, type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import type { CanvasPattern } from '../../../../shared/types'
import { useCanvasOptions } from '../../lib/canvas'
import type { RingGuides } from '../../lib/layout'
import '../../styles/canvas.css'

/**
 * The canvas backdrop, rendered as a child of <ReactFlow> on every canvas (Live run, Team editor, settings sample).
 * It reads the pattern from useCanvasOptions() and follows pan and zoom. `rings` draws the radial layout's guides as
 * part of the backdrop. Spec: docs/design/canvas-themes.md section 2. Colours come from CSS (styles/canvas.css).
 */

/** Tile size in flow units at zoom 1, per pattern (none has no tile). */
const TILE: Record<CanvasPattern, [number, number]> = {
  dots: [22, 22],
  grid: [22, 22],
  none: [0, 0],
  blueprint: [100, 100],
  paper: [28, 28],
  isometric: [41.5692, 24],
  circuit: [120, 120],
  terminal: [22, 22],
  starfield: [240, 240]
}

const SMALL_STARS: Array<[number, number, number]> = [
  [18, 32, 1],
  [72, 140, 0.8],
  [196, 18, 0.8],
  [222, 170, 1],
  [40, 210, 1.2],
  [110, 196, 0.8],
  [160, 112, 1],
  [90, 92, 0.8]
]
const BRIGHT_STARS: Array<[number, number, number]> = [
  [130, 60, 1.2],
  [204, 226, 1.2]
]

function TileContent({ pattern }: { pattern: CanvasPattern }): ReactElement | null {
  switch (pattern) {
    case 'dots':
      return <circle className="canvas-fill" cx={0} cy={0} r={1.2} />
    case 'terminal':
      return <circle className="canvas-fill" cx={0} cy={0} r={1} />
    case 'grid':
      return <path className="canvas-line" d="M0 0V22 M0 0H22" />
    case 'blueprint':
      return (
        <>
          <path className="canvas-line" d="M20 0V100 M40 0V100 M60 0V100 M80 0V100 M0 20H100 M0 40H100 M0 60H100 M0 80H100" />
          <path className="canvas-line canvas-line-strong canvas-line-major" d="M0 0V100 M0 0H100" />
        </>
      )
    case 'paper':
      return <path className="canvas-line" d="M0 27.5H28" />
    case 'isometric':
      return <path className="canvas-line" d="M0 0V24 M20.7846 0V24 M0 24L41.5692 0 M0 0L41.5692 24" />
    case 'circuit':
      return (
        <>
          <path
            className="canvas-line canvas-trace"
            d="M0 30H40L55 45H85L100 30H120 M30 0V55L45 70V90L30 105V120 M75 60H105 M60 0V12 M60 108V120"
          />
          {([[75, 60], [105, 60], [60, 12], [60, 108]] as const).map(([x, y]) => (
            <circle key={`${x}-${y}`} className="canvas-pad" cx={x} cy={y} r={3} />
          ))}
          <circle className="canvas-via" cx={30} cy={30} r={2} />
        </>
      )
    case 'starfield':
      return (
        <>
          {SMALL_STARS.map(([x, y, r]) => (
            <circle key={`s${x}-${y}`} className="canvas-fill" cx={x} cy={y} r={r} />
          ))}
          {BRIGHT_STARS.map(([x, y, r]) => (
            <circle key={`b${x}-${y}`} className="canvas-fill canvas-fill-strong" cx={x} cy={y} r={r} />
          ))}
        </>
      )
    default:
      return null
  }
}

/** The `<pattern>` and the rect that paints it. Place inside an `<svg>`; `transform` is a patternTransform string. */
export function BackdropPatternDefs({
  id,
  pattern,
  transform
}: {
  id: string
  pattern: CanvasPattern
  transform: string
}): ReactElement | null {
  const [w, h] = TILE[pattern]
  if (pattern === 'none') return null
  return (
    <>
      <defs>
        <pattern id={id} patternUnits="userSpaceOnUse" width={w} height={h} patternTransform={transform}>
          <TileContent pattern={pattern} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </>
  )
}

/** Ring guides in flow coordinates; `transform` is an SVG transform string for the viewport. */
export function BackdropRings({ rings, transform }: { rings: RingGuides; transform: string }): ReactElement {
  return (
    <g transform={transform}>
      {rings.radii.map((r) => (
        <circle key={r} className="canvas-ring" cx={rings.cx} cy={rings.cy} r={r} />
      ))}
    </g>
  )
}

/**
 * A fixed-size sample of a backdrop for thumbnails: draws `pattern` at `scale` into a `width` x `height` svg. The caller
 * sets `data-canvas-thumb` on it (or an ancestor) so tokens.css gives it that backdrop's colours.
 */
export function BackdropTile({
  pattern,
  scale = 0.25,
  width,
  height
}: {
  pattern: CanvasPattern
  scale?: number
  width: number
  height: number
}): ReactElement {
  const id = `bt${useId().replace(/:/g, '')}`
  return (
    <svg className="canvas-backdrop canvas-backdrop-tile" data-pattern={pattern} width={width} height={height} aria-hidden="true">
      <BackdropPatternDefs id={id} pattern={pattern} transform={`scale(${scale})`} />
    </svg>
  )
}

export function CanvasBackdrop({ rings }: { rings?: RingGuides }): ReactElement {
  const { pattern } = useCanvasOptions()
  const transform = useStore((s) => s.transform)
  const id = `bd${useId().replace(/:/g, '')}`
  const [x, y, zoom] = transform
  const view = `translate(${x} ${y}) scale(${zoom})`
  return (
    <>
      <svg className="canvas-backdrop" data-testid="canvas-backdrop" data-pattern={pattern} aria-hidden="true">
        <BackdropPatternDefs id={id} pattern={pattern} transform={view} />
        {rings && rings.radii.length > 0 ? <BackdropRings rings={rings} transform={view} /> : null}
      </svg>
      {pattern === 'terminal' ? <div className="canvas-scanlines" aria-hidden="true" /> : null}
    </>
  )
}
