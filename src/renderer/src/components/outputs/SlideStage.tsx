// One slide drawn from SlidePreview as React elements, never HTML (docs/design/outputs-2.md 13.2). Geometry is fractions of
// the slide, font sizes are cqw of the paper (a size container), the paper stays light in both themes. Used by the viewer,
// the strip, compare and the grid thumbnails.
import { memo } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { DocumentRun, SlidePreview, SlideRun, SlideShape } from '@shared/types'
import {
  ANCHOR_FLEX,
  boxPercent,
  bulletLabels,
  cqwSize,
  levelIndentEm,
  safeColor,
  safeImageUrl,
  slideAspect
} from '../../lib/slideStage'
import '../../styles/outputs-slides.css'

export interface SlideStageProps {
  slide: SlidePreview
  /** Slide size in points (preview.size). */
  size: { w: number; h: number }
  /** A miniature: contents aria-hidden, no region layer. */
  thumbnail?: boolean
  /** Extra layer drawn over the slide in slide coordinates (the viewer passes the RegionLayer). */
  children?: ReactNode
}

const DEFAULT_PT = 18

function runStyle(r: SlideRun, widthPt: number): CSSProperties {
  const deco = [r.underline ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  return {
    fontSize: `${cqwSize(r.sizePt ?? DEFAULT_PT, widthPt)}cqw`,
    fontWeight: r.bold ? 700 : undefined,
    fontStyle: r.italic ? 'italic' : undefined,
    textDecoration: deco || undefined,
    color: safeColor(r.color)
  }
}

function cellText(cell: DocumentRun[]): ReactNode {
  return cell.map((r, i) => (
    <span key={i} style={{ fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? 'italic' : undefined }}>
      {r.text}
    </span>
  ))
}

function Shape({ s, widthPt }: { s: SlideShape; widthPt: number }): ReactElement | null {
  const pos = { position: 'absolute' as const, ...boxPercent(s) }
  switch (s.type) {
    case 'text': {
      const labels = bulletLabels(s.paragraphs)
      const style: CSSProperties = {
        ...pos,
        justifyContent: ANCHOR_FLEX[s.anchor ?? 'top'],
        background: safeColor(s.fill),
        borderColor: safeColor(s.line)
      }
      return (
        <div className="slide-text" style={style} data-line={s.line && safeColor(s.line) ? 'true' : undefined}>
          {s.paragraphs.map((p, i) => (
            <p
              key={i}
              className="slide-para"
              style={{ textAlign: p.align ?? 'left', paddingInlineStart: `${levelIndentEm(p.level)}em` }}
            >
              {labels[i] ? (
                <span className="slide-bullet" style={runStyle(p.runs[0] ?? { text: '' }, widthPt)}>
                  {labels[i]}
                </span>
              ) : null}
              <span className="slide-runs">
                {p.runs.length === 0 ? ' ' : null}
                {p.runs.map((r, j) => (
                  <span key={j} style={runStyle(r, widthPt)}>
                    {r.text}
                  </span>
                ))}
              </span>
            </p>
          ))}
        </div>
      )
    }
    case 'image': {
      const url = safeImageUrl(s.dataUrl)
      if (!url) return <div className="slide-placeholder" style={pos}><span>Picture (not shown)</span></div>
      return <img className="slide-image" style={pos} src={url} alt={s.alt ?? ''} draggable={false} />
    }
    case 'shape': {
      const fill = safeColor(s.fill)
      const line = safeColor(s.line)
      const round = s.geometry === 'ellipse' ? '50%' : s.geometry === 'roundRect' ? '12%' : undefined
      const outline = s.geometry === 'other' && !line
      return (
        <div
          className="slide-shape"
          style={{ ...pos, background: fill, borderColor: line, borderStyle: line || outline ? 'solid' : 'none', borderRadius: round }}
          data-outline={outline ? 'true' : undefined}
        />
      )
    }
    case 'table':
      return (
        <div className="slide-table" style={pos}>
          <table>
            <tbody>
              {s.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>{cellText(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'placeholder':
      return (
        <div className="slide-placeholder" style={pos}>
          <span>{s.label === 'Picture' ? 'Picture (not shown)' : s.label}</span>
          {s.alt ? <span className="slide-placeholder-alt">{s.alt}</span> : null}
        </div>
      )
    default:
      return null
  }
}

function SlideStageImpl({ slide, size, thumbnail, children }: SlideStageProps): ReactElement {
  const widthPt = size.w > 0 ? size.w : 960
  const paper = safeColor(slide.background) ?? '#ffffff'
  return (
    <div
      className="slide-paper"
      data-thumbnail={thumbnail ? 'true' : undefined}
      aria-hidden={thumbnail ? 'true' : undefined}
      style={{ ['--slide-aspect' as string]: String(slideAspect(size)), background: paper }}
    >
      <div className="slide-layer" aria-hidden={thumbnail ? 'true' : undefined}>
        {slide.shapes.map((s, i) => (
          <Shape key={i} s={s} widthPt={widthPt} />
        ))}
      </div>
      {thumbnail ? null : children}
    </div>
  )
}

const SlideStage = memo(SlideStageImpl)
export default SlideStage
