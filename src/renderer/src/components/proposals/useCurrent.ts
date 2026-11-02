import { useEffect, useState } from 'react'
import type { McpServerSpec } from '@shared/types'

export type ReadStatus = 'loading' | 'ok' | 'error'

export interface McpCurrent {
  /** The project's servers now (project scope), or the library's entries (library scope); null until known or when the read failed. */
  servers: McpServerSpec[] | null
  /** Library entries as specs, for a link row's command; null until known or when the read failed. */
  library: McpServerSpec[] | null
  /** 'loading' until every needed read settled; 'error' when any failed. */
  status: ReadStatus
  /** Which read failed. */
  failed: { servers: boolean; library: boolean }
}

/**
 * Reads what the card compares against through the preload, so a server added by IPC shows up (the store's copy can be
 * stale): the project's servers (project scope) and/or the library (library scope, or when a row links an entry).
 * A failed project read falls back to `storeServers`.
 */
export function useMcpCurrent(opts: { active: boolean; scope: 'project' | 'library'; projectId: string | undefined; needsLibrary: boolean; storeServers: McpServerSpec[] | null }): McpCurrent {
  const { active, scope, projectId, needsLibrary, storeServers } = opts
  const needsProject = active && scope === 'project' && !!projectId
  const [project, setProject] = useState<{ status: ReadStatus; list: McpServerSpec[] | null }>({ status: 'loading', list: null })
  const [lib, setLib] = useState<{ status: ReadStatus; list: McpServerSpec[] | null }>({ status: 'loading', list: null })
  useEffect(() => {
    if (!needsProject || !projectId) return
    let live = true
    setProject({ status: 'loading', list: null })
    window.orgai.mcp
      .list(projectId)
      .then((list) => {
        if (live) setProject({ status: 'ok', list: list.map((i) => i.spec) })
      })
      .catch(() => {
        if (live) setProject({ status: 'error', list: null })
      })
    return () => {
      live = false
    }
  }, [needsProject, projectId])
  const wantLib = active && needsLibrary
  useEffect(() => {
    if (!wantLib) return
    let live = true
    setLib({ status: 'loading', list: null })
    window.orgai.mcpLibrary
      .list()
      .then((list) => {
        if (live) setLib({ status: 'ok', list: list.map((i) => ({ ...i.entry, enabled: true }) as McpServerSpec) })
      })
      .catch(() => {
        if (live) setLib({ status: 'error', list: null })
      })
    return () => {
      live = false
    }
  }, [wantLib])
  const libraryScope = active && scope === 'library'
  const projectLoading = needsProject && project.status === 'loading'
  const libLoading = wantLib && lib.status === 'loading'
  const failed = { servers: (needsProject && project.status === 'error') || (libraryScope && lib.status === 'error'), library: wantLib && lib.status === 'error' }
  const status: ReadStatus = projectLoading || libLoading ? 'loading' : failed.servers || failed.library ? 'error' : 'ok'
  const servers = libraryScope ? lib.list : needsProject ? (project.list ?? (project.status === 'error' ? storeServers : null)) : storeServers
  return { servers, library: wantLib ? lib.list : null, status, failed }
}
