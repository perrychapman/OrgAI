import type { ReactElement, Ref } from 'react'
import { kindLabel } from '../../lib/knowledge'
import { comesUpLine, topRelationLines, type RelationRow } from '../../lib/knowledgeNeural'
import { KindMark } from './KindMark'

export interface NeuralCardData {
  /** The id, written to `data-id` only when it passes the id check. */
  id: string | undefined
  name: string
  kind: string
  retired: boolean
  excerpt: string
  appearance: { relations: number; mentions: number; notes: number; total: number }
  rows: readonly RelationRow[]
  shared: string | null
}

/**
 * The hover / keyboard-focus card (docs/design/knowledge-graph-2.md section 1.5). Decorative: the option's spoken name
 * says the same, so the card is aria-hidden and takes no pointer events. Its position is set by the canvas (cardPlacement).
 */
export function NeuralCard({ data, cardRef, instant }: { data: NeuralCardData; cardRef: Ref<HTMLDivElement>; instant: boolean }): ReactElement {
  const { lines, more } = topRelationLines(data.rows)
  return (
    <div ref={cardRef} className="neural-card" data-testid="knowledge-neural-card" data-id={data.id} data-instant={instant ? 'true' : 'false'} aria-hidden="true">
      <p className="neural-card-name">{data.name}</p>
      <p className="neural-card-kind">
        <KindMark kind={data.kind} />
        <span>
          {kindLabel(data.kind)}
          {data.retired ? ', retired' : ''}
        </span>
      </p>
      {data.excerpt && <p className="neural-card-excerpt">{data.excerpt}</p>}
      <p className="neural-card-count" data-testid="knowledge-neural-card-count">
        {comesUpLine(data.appearance)}
      </p>
      {lines.length > 0 && (
        <ul className="neural-card-relations">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
          {more && <li className="neural-card-more">{more}</li>}
        </ul>
      )}
      {data.shared && (
        <p className="neural-card-shared" data-testid="knowledge-neural-card-shared">
          {data.shared}
        </p>
      )}
    </div>
  )
}
