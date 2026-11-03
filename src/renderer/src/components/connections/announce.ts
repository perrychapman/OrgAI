import { createContext, useContext } from 'react'

/**
 * The Connections pane's one polite live region. Cards announce through it (status changes, default changes and
 * refusals) so the pane has a single `role=status` instead of one per card.
 */
export const ConnectionsAnnounceContext = createContext<(message: string) => void>(() => undefined)

export function useConnectionsAnnounce(): (message: string) => void {
  return useContext(ConnectionsAnnounceContext)
}
