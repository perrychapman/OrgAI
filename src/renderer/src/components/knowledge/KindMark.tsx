import type { CSSProperties, ReactElement } from 'react'
import { kindColor, kindMark } from '../../lib/knowledge'
import '../../styles/knowledge-mark.css'

/**
 * A kind's colour and shape as a 10 px decorative dot (docs/design/knowledge-graph-2.md section 1.4): filter chips,
 * the graph legend and card, the run Knowledge tab. Decorative: the kind's name always sits beside it.
 */
export function KindMark({ kind }: { kind: string }): ReactElement {
  return <span className="knowledge-kind-mark" data-testid="knowledge-kind-mark" data-mark={kindMark(kind)} aria-hidden="true" style={{ '--kind-color': kindColor(kind) } as CSSProperties} />
}
