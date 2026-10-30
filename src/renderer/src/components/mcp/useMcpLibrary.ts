import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpLibraryInfo } from '@shared/types'
import { errMessage } from './mcpHelpers'

/** The app-wide MCP library, loaded once and kept fresh from mcpLibrary:changed pushes. null = still loading. */
export function useMcpLibrary(): {
  library: McpLibraryInfo[] | null
  error: string | null
  refresh: () => void
  setLibrary: (list: McpLibraryInfo[]) => void
} {
  const [library, setList] = useState<McpLibraryInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const setLibrary = useCallback((list: McpLibraryInfo[]): void => {
    seq.current++
    setList(list)
    setError(null)
  }, [])

  const refresh = useCallback((): void => {
    const mine = ++seq.current
    window.orgai.mcpLibrary
      .list()
      .then((list) => {
        if (mine !== seq.current) return
        setList(list)
        setError(null)
      })
      .catch((e) => {
        if (mine === seq.current) setError(errMessage(e))
      })
  }, [])

  useEffect(() => {
    refresh()
    return window.orgai.onMcpLibraryChanged((list) => setLibrary(list))
  }, [refresh, setLibrary])

  return { library, error, refresh, setLibrary }
}
