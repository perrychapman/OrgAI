import type { EngagementNote, EngagementNoteSaveInput, KnowledgeEdge, KnowledgeEdgeSaveInput, KnowledgeNode, KnowledgeNodeSaveInput } from '@shared/types'

/**
 * The writes the detail pane makes, bound to the project by KnowledgeView, which counts them as its own (so their push
 * events are not announced as the team's), refetches afterwards and never applies a result directly (spec 3).
 * Every call rejects with the main-side message (cleaned by the caller).
 */
export interface KnowledgeWrites {
  saveNode(input: Omit<KnowledgeNodeSaveInput, 'projectId'>): Promise<KnowledgeNode>
  removeNode(nodeId: string): Promise<void>
  saveEdge(input: Omit<KnowledgeEdgeSaveInput, 'projectId'>): Promise<KnowledgeEdge>
  removeEdge(edgeId: string): Promise<void>
  saveNote(input: Omit<EngagementNoteSaveInput, 'projectId'>): Promise<EngagementNote>
  removeNote(noteId: string): Promise<void>
}

/** Two animation frames: after React has committed and the browser has laid out (hidden -> shown panel bodies). */
export function focusLater(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => requestAnimationFrame(() => find()?.focus()))
}
