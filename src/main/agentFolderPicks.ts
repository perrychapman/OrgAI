/**
 * Folders a window picked with importSources.pickAgentFolder (UI overhaul). AgentImportInput.sourcePath is honoured only
 * when the same window picked exactly that path (no path typed by a renderer, an agent or a CLI client is ever read).
 * In-memory, per sender, newest AGENT_FOLDER_PICKS_MAX kept.
 */
export const AGENT_FOLDER_PICKS_MAX = 8

const bySender = new Map<number, string[]>()

export function rememberAgentFolder(senderId: number, path: string): void {
  const list = (bySender.get(senderId) ?? []).filter((p) => p !== path)
  list.push(path)
  while (list.length > AGENT_FOLDER_PICKS_MAX) list.shift()
  bySender.set(senderId, list)
}

/** True when `senderId` picked exactly `path` (string equality, no normalization). */
export function isPickedAgentFolder(senderId: number | undefined, path: unknown): boolean {
  if (typeof senderId !== 'number' || typeof path !== 'string' || !path) return false
  return bySender.get(senderId)?.includes(path) === true
}

export function forgetAgentFolders(senderId: number): void {
  bySender.delete(senderId)
}
