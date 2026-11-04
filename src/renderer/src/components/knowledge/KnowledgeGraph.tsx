import type { ReactElement } from 'react'
import type { KnowledgeGraph as KnowledgeGraphData } from '@shared/types'
import type { KnowledgeFilter } from '../../lib/knowledge'
import '../../styles/knowledge-graph.css'

/**
 * The Knowledge tab's Graph view (docs/design/knowledge.md section 5): a React Flow canvas of the selected item's
 * neighbourhood, sharing the list's filter and selection. The props are the contract between KnowledgeView (the list,
 * detail pane and view switch) and this component; depth, "Show all" and the legend are its own state.
 */
export interface KnowledgeGraphProps {
  projectId: string
  graph: KnowledgeGraphData
  /** The list's filter (kinds, origins, showRetired, query), applied before layout. */
  filter: KnowledgeFilter
  /** The selection the list, the detail pane and the graph share (a node id; a note id or null = no centre). */
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Enter on a node (or a double click): open the detail pane with focus on its heading. */
  onOpen: (id: string) => void
  /** DOM ids the "Skip to list" / "Skip to detail" links target. */
  listDomId: string
  detailDomId: string
  /** Speak through the tab's one polite status region. */
  announce: (text: string) => void
}

/** Placeholder until the graph lands (ui-engineer-2 replaces this file). */
export default function KnowledgeGraph(_props: KnowledgeGraphProps): ReactElement {
  return (
    <div className="knowledge-graph" data-testid="knowledge-graph">
      <p className="panel-note">The graph view is not built yet.</p>
    </div>
  )
}
