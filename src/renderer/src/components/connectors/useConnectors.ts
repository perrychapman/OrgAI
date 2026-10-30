import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectorInfo } from '@shared/types'
import { errMessage } from '../mcp/mcpHelpers'

/** Every connector preset with its library entry and state; re-read whenever the MCP library changes. null = loading. */
export function useConnectors(): { connectors: ConnectorInfo[] | null; error: string | null; refresh: () => void } {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const refresh = useCallback((): void => {
    const mine = ++seq.current
    window.orgai.connectors
      .list()
      .then((list) => {
        if (mine !== seq.current) return
        setConnectors(list)
        setError(null)
      })
      .catch((e) => {
        if (mine === seq.current) setError(errMessage(e))
      })
  }, [])
  useEffect(() => {
    refresh()
    return window.orgai.onMcpLibraryChanged(() => refresh())
  }, [refresh])
  return { connectors, error, refresh }
}
