import type { ReactElement } from 'react'
import { useId } from 'react'
import type { CanvasEdgeStyle, CanvasLayout, CanvasNodeStyle, CanvasPattern } from '@shared/types'
import { ROLE_COLORS } from '@shared/defaults'

/** What a thumbnail draws. */
export interface ThumbSpec {
  pattern: CanvasPattern
  edges: CanvasEdgeStyle
  layout: CanvasLayout
  nodeStyle: CanvasNodeStyle
}

const W = 72
const H = 48

/** Root and two reports per layout, as centres in the 72 x 48 box. */
const POINTS: Record<CanvasLayout, [number, number][]> = {
  'top-down': [[36, 11], [18, 37], [54, 37]],
  'left-right': [[13, 24], [57, 12], [57, 36]],
  radial: [[36, 24], [13, 38], [59, 12]]
}

function path(layout: CanvasLayout, edges: CanvasEdgeStyle, a: [number, number], b: [number, number]): string {
  const [x1, y1] = a
  const [x2, y2] = b
  if (layout === 'radial') {
    if (edges === 'curved') return `M${x1} ${y1} Q${(x1 + x2) / 2 + (y2 - y1) * 0.12} ${(y1 + y2) / 2 - (x2 - x1) * 0.12} ${x2} ${y2}`
    return `M${x1} ${y1} L${x2} ${y2}`
  }
  const lr = layout === 'left-right'
  if (edges === 'straight') return `M${x1} ${y1} L${x2} ${y2}`
  if (edges === 'orthogonal') {
    return lr ? `M${x1} ${y1} H${(x1 + x2) / 2} V${y2} H${x2}` : `M${x1} ${y1} V${(y1 + y2) / 2} H${x2} V${y2}`
  }
  return lr
    ? `M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`
    : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
}

/** The backdrop pattern at about a quarter scale, from the canvas tokens in effect on the svg. */
function patternDef(pattern: CanvasPattern, id: string): ReactElement | null {
  const line = { stroke: 'var(--canvas-pattern)', strokeWidth: 0.5, fill: 'none' }
  switch (pattern) {
    case 'dots':
    case 'terminal':
      return (
        <pattern id={id} width="5.5" height="5.5" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="var(--canvas-pattern)" />
        </pattern>
      )
    case 'grid':
      return (
        <pattern id={id} width="5.5" height="5.5" patternUnits="userSpaceOnUse">
          <path d="M0 0H5.5M0 0V5.5" {...line} />
        </pattern>
      )
    case 'blueprint':
      return (
        <pattern id={id} width="25" height="25" patternUnits="userSpaceOnUse">
          <path d="M5 0V25M10 0V25M15 0V25M20 0V25M0 5H25M0 10H25M0 15H25M0 20H25" {...line} />
          <path d="M0 0H25M0 0V25" stroke="var(--canvas-pattern-strong)" strokeWidth="0.7" fill="none" />
        </pattern>
      )
    case 'paper':
      return (
        <pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse">
          <path d="M0 6.5H7" {...line} />
        </pattern>
      )
    case 'isometric':
      return (
        <pattern id={id} width="10.39" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 0V6M5.2 0V6M0 6L10.39 0M0 0L10.39 6" {...line} />
        </pattern>
      )
    case 'circuit':
      return (
        <pattern id={id} width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M0 7.5H10L14 11H21L25 7.5H30M7.5 0V14L11 17.5V22.5L7.5 26V30" {...line} />
          <circle cx="19" cy="15" r="1" fill="var(--canvas-bg)" stroke="var(--canvas-pattern-strong)" strokeWidth="0.5" />
        </pattern>
      )
    case 'starfield':
      return (
        <pattern id={id} width="60" height="60" patternUnits="userSpaceOnUse">
          <circle cx="4.5" cy="8" r="0.5" fill="var(--canvas-pattern)" />
          <circle cx="18" cy="35" r="0.4" fill="var(--canvas-pattern)" />
          <circle cx="49" cy="4.5" r="0.4" fill="var(--canvas-pattern)" />
          <circle cx="40" cy="28" r="0.5" fill="var(--canvas-pattern)" />
          <circle cx="32" cy="15" r="0.7" fill="var(--canvas-pattern-strong)" />
          <circle cx="51" cy="56" r="0.7" fill="var(--canvas-pattern-strong)" />
        </pattern>
      )
    default:
      return null
  }
}

/**
 * A small picture of a canvas style: its backdrop pattern, a root and two reports in its layout and node style, joined
 * in its line style, coloured with the first three role colours. `preset` sets data-canvas-thumb, which makes tokens.css
 * give the svg that backdrop's tokens whatever is active; omit it (Custom) to show the current settings.
 */
export function CanvasThumb({ spec, preset, width = W, height = H }: { spec: ThumbSpec; preset?: boolean; width?: number; height?: number }): ReactElement {
  const rawId = useId()
  const pid = `thumb-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const pts = POINTS[spec.layout]
  const compact = spec.nodeStyle === 'compact'
  const station = spec.nodeStyle === 'station'
  const nw = compact ? 14 : 18
  const nh = compact ? 5 : 10
  const def = patternDef(spec.pattern, pid)
  return (
    <svg
      className="canvas-thumb"
      viewBox={`0 0 ${W} ${H}`}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
      data-canvas-thumb={preset ? spec.pattern : undefined}
    >
      {def && <defs>{def}</defs>}
      <rect width={W} height={H} fill="var(--canvas-bg)" />
      {def && <rect width={W} height={H} fill={`url(#${pid})`} />}
      {[1, 2].map((i) => (
        <path
          key={i}
          d={path(spec.layout, spec.edges, pts[0], pts[i])}
          fill="none"
          strokeWidth={station ? 2.4 : 1.2}
          strokeLinecap={station ? 'round' : undefined}
          strokeLinejoin={station ? 'round' : undefined}
          // Subway lines take the lead's (here the root's) colour; every other style colours a line by its report.
          style={{ stroke: `color-mix(in srgb, ${ROLE_COLORS[station ? 0 : i]} var(--canvas-edge-role-mix), var(--canvas-edge-ink))` }}
        />
      ))}
      {pts.map(([cx, cy], i) =>
        station ? (
          <circle key={i} cx={cx} cy={cy} r="3.2" fill="var(--canvas-node-bg)" stroke={ROLE_COLORS[i]} strokeWidth="1.6" />
        ) : spec.nodeStyle === 'hex' ? (
          <polygon
            key={i}
            points={`${cx - 7},${cy} ${cx - 3.5},${cy - 6} ${cx + 3.5},${cy - 6} ${cx + 7},${cy} ${cx + 3.5},${cy + 6} ${cx - 3.5},${cy + 6}`}
            fill="var(--canvas-node-bg)"
            stroke={ROLE_COLORS[i]}
            strokeWidth="1"
            strokeLinejoin="round"
          />
        ) : (
        <rect
          key={i}
          x={cx - nw / 2}
          y={cy - nh / 2}
          width={nw}
          height={nh}
          rx={compact ? nh / 2 : 2}
          fill="var(--canvas-node-bg)"
          stroke={ROLE_COLORS[i]}
          strokeWidth="1"
        />
        )
      )}
    </svg>
  )
}
