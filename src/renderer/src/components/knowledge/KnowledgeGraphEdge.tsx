import type { ReactElement } from 'react'
import { BezierEdge, SmoothStepEdge, StraightEdge, useViewport, type EdgeProps } from '@xyflow/react'
import { RadialEdge } from '../canvas/RadialEdge'
import { edgeLabelsShown } from '../../lib/knowledgeGraph'

/** The line shape a Knowledge edge draws: the canvas's Connection lines setting, or 'radial' in the radial layout. */
export type KnowledgeEdgeKind = 'default' | 'smoothstep' | 'straight' | 'radial'

export interface KnowledgeEdgeData extends Record<string, unknown> {
  kind: KnowledgeEdgeKind
  /** The relation as words ("works at"); shown as the label at zoom 1 and above, else only in the title. */
  label?: string
  /** The SVG title (hover): "Jane Doe works at Acme Corp". */
  title: string
}

/**
 * Edge type 'knowledge' (docs/design/knowledge.md section 5): a wrapper that gives the line an SVG `<title>` with the
 * relation sentence and shows the relation words as the label only at zoom >= 1 (`edgeLabelsShown`). The path itself
 * is the canvas's edge for the lines setting (Bezier, smooth step, straight) or the radial edge. Edges are not
 * focusable; the relation also lives in both nodes' spoken names.
 */
export function KnowledgeGraphEdge(props: EdgeProps): ReactElement {
  const { zoom } = useViewport()
  const data = props.data as KnowledgeEdgeData | undefined
  const kind = data?.kind ?? 'default'
  const label = data?.label && edgeLabelsShown(zoom) ? data.label : undefined
  const inner = { ...props, label }
  // `pathOptions` is a per-edge field React Flow hands to the built-in components (the station style's rounded corners).
  const path = (props as EdgeProps & { pathOptions?: unknown }).pathOptions as never
  return (
    <g className="knowledge-edge" data-relation={data?.label ?? ''}>
      <title>{data?.title ?? ''}</title>
      {kind === 'radial' ? <RadialEdge {...inner} /> : kind === 'smoothstep' ? <SmoothStepEdge {...inner} pathOptions={path} /> : kind === 'straight' ? <StraightEdge {...inner} /> : <BezierEdge {...inner} pathOptions={path} />}
    </g>
  )
}
