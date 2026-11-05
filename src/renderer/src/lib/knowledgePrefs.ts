/** The Knowledge tab's per-project preferences in localStorage. */
export const KNOWLEDGE_VIEW_KEY = 'orgai.knowledgeView.'
export const KNOWLEDGE_RETIRED_KEY = 'orgai.knowledgeRetired.'
export const KNOWLEDGE_INFERRED_KEY = 'orgai.knowledgeInferred.'
/** The graph's settled positions. */
export const layoutKey = (projectId: string): string => `orgai.knowledgeLayout.${projectId}`

/** A removed or forgotten project leaves nothing behind: its view, switches and stored graph layout go with it. */
export function clearKnowledgePrefs(projectId: string): void {
  for (const key of [KNOWLEDGE_VIEW_KEY + projectId, KNOWLEDGE_RETIRED_KEY + projectId, KNOWLEDGE_INFERRED_KEY + projectId, layoutKey(projectId)]) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* storage blocked: nothing to clear */
    }
  }
}
