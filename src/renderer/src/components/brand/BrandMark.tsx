import type { CSSProperties, ReactElement } from 'react'
import { brandMark } from './brandMarks'

/** Inline SVG brand mark, or null when the id has none. Decorative: the name is always text beside it. */
export function BrandMark({ id }: { id: string }): ReactElement | null {
  const mark = brandMark(id)
  if (!mark) return null
  return (
    <svg
      className="brand-mark"
      viewBox={mark.viewBox ?? '0 0 24 24'}
      aria-hidden="true"
      focusable="false"
      fill={mark.hex ?? 'currentColor'}
      data-dark={mark.darkHex ? '' : undefined}
      style={mark.darkHex ? ({ '--brand-dark': mark.darkHex } as CSSProperties) : undefined}
      fillRule={mark.evenodd ? 'evenodd' : undefined}
    >
      <path d={mark.d} />
      {mark.extra?.map((p) => (
        <path key={p.hex} d={p.d} fill={p.hex} />
      ))}
    </svg>
  )
}
