import type { CSSProperties, ReactElement } from 'react'
import { NOTE_KIND, kindColor, kindMark } from '../../lib/knowledge'
import '../../styles/knowledge-mark.css'

/**
 * A kind's colour and shape as a 10 px decorative dot (docs/design/knowledge-graph-2.md section 1.4): filter chips,
 * the graph legend and card, list rows and group titles, the detail head, the run Knowledge tab. Decorative: the
 * kind's name always sits beside it. A context note has no kind colour: it gets the neutral dot.
 */
export function KindMark({ kind }: { kind: string }): ReactElement {
  if (kind === NOTE_KIND) return <span className="knowledge-kind-mark knowledge-note-dot" data-testid="knowledge-kind-mark" data-mark="dot" aria-hidden="true" />
  return <span className="knowledge-kind-mark" data-testid="knowledge-kind-mark" data-mark={kindMark(kind)} aria-hidden="true" style={{ '--kind-color': kindColor(kind) } as CSSProperties} />
}
