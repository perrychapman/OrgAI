import type { ReactElement, Ref } from 'react'
import type { KnowledgeGraph as KnowledgeGraphData, KnowledgeInferredResult } from '@shared/types'
import type { KnowledgeFilter } from '../../lib/knowledge'

/** What KnowledgeView can ask of the graph. */
export interface KnowledgeNeuralHandle {
  /** Move focus to a node's DOM element: this id, else the entry rule (last focused, selected, largest). False when no node can take it. */
  focusNode(id: string | null): boolean
}

/** The contract between KnowledgeView and the neural canvas (docs/design/knowledge-graph-2.md section 1). */
export interface KnowledgeNeuralProps {
  projectId: string
  graph: KnowledgeGraphData
  /** Null until the first answer, or when the read failed: sizes then come from live edges. */
  inferred: KnowledgeInferredResult | null
  /** The list's filter, shared: filtered-out nodes dim and never move. */
  filter: KnowledgeFilter
  /** The "Inferred links" switch: draw every kept pair's inferred link, not only the active node's. */
  showInferred: boolean
  selectedId: string | null
  /** Space on a node selects it; a click on empty space passes null. The panel stays as it is. */
  onSelect: (id: string | null) => void
  /** A click on a node: select it and open the detail panel. Focus stays on the node. */
  onOpenPanel: (id: string) => void
  /** Enter on a node: select it, open the detail panel and send focus to its heading. */
  onOpen: (id: string) => void
  /** "Show as list": switch the view and focus the selected or first row. */
  onShowList: () => void
  /** "Skip to detail": focus the detail heading, or the rail's Show button while the panel is a rail. */
  onSkipToDetail: () => void
  /** The "No items match" state's button (`knowledge-clear-filters`): clear search, kinds and origins. */
  onClearFilters: () => void
  /** Speak through the tab's one polite status region. */
  announce: (text: string) => void
  ref?: Ref<KnowledgeNeuralHandle>
}

/** Placeholder until the canvas lands. */
export default function KnowledgeNeural(_props: KnowledgeNeuralProps): ReactElement {
  return <div data-testid="knowledge-neural" />
}
