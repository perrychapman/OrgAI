import type { AgentMessage } from '@shared/types'

export interface MessageCursor { runId?: string; seen: readonly AgentMessage[] }

/** A run boundary is a fresh baseline, including prefilled live-only history. */
export function consumeSceneMessages(cursor: MessageCursor, runId: string | undefined, messages: readonly AgentMessage[]) {
  if (cursor.runId !== runId) return { cursor: { runId, seen: messages.slice() }, fresh: [] as AgentMessage[], reset: true }
  let overlap = Math.min(cursor.seen.length, messages.length)
  while (overlap > 0 && !cursor.seen.slice(-overlap).every((message, i) => message === messages[i])) overlap--
  return { cursor: { runId, seen: messages.slice() }, fresh: messages.slice(overlap), reset: false }
}
