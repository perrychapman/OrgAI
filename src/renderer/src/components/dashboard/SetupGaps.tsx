import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { ConnectorInfo, McpLibraryInfo, McpServerInfo } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_PANES, requestAppSettingsSection, requestConnector } from '../../lib/settingsTarget'
import { connectionRow, connectionsNeeded, libraryRows, orderSetupRows, projectServerRows, projectsWithOwnServers, type SetupRow, type SetupTarget } from '../../lib/setupGaps'
import { ListTodo } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { connectionProblems } from './dashboardProjects'
import { afterFirstPaint, projectQueue } from './projectQueue'

/**
 * To set up (docs/design/dashboard-2.md section 8): what will make a run fail or skip a service. The Briefing shows one
 * line ("2 things to set up") that opens a popover holding the rows. Rows come from the connection list, the MCP library,
 * the connector gallery and (through the shared project queue) each project's own servers. Never counted as decisions,
 * never in the bell. Loads after first paint and again when the library changes; a failed call leaves its rows out
 * silently. Renders nothing when empty.
 */
export function SetupGaps(): ReactElement | null {
  const connections = useAppStore((s) => s.connections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const projects = useAppStore((s) => s.projects)
  const mockAdapter = useAppStore((s) => s.appInfo?.mockAdapter)
  const [library, setLibrary] = useState<McpLibraryInfo[]>([])
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [serverRows, setServerRows] = useState<Record<string, SetupRow[]>>({})
  const [loaded, setLoaded] = useState(false)

  const loadLibrary = (): void => {
    window.orgai.mcpLibrary.list().then(setLibrary, (e: unknown) => console.debug('to set up: library', e))
    window.orgai.connectors.list().then(setConnectors, (e: unknown) => console.debug('to set up: connectors', e))
  }

  // After first paint, and again whenever the library changes (the main process pushes the new list).
  useEffect(() => {
    const cancel = afterFirstPaint(() => {
      loadLibrary()
      setLoaded(true)
    })
    const off = window.orgai.onMcpLibraryChanged((entries) => {
      setLibrary(entries)
      window.orgai.connectors.list().then(setConnectors, (e: unknown) => console.debug('to set up: connectors', e))
    })
    return () => {
      cancel()
      off()
    }
  }, [])

  // A connection that connected, disconnected or was added changes what the library can sign in to.
  // Keyed on ids, states and enabled flags, so a status refresh that changes nothing does not refetch (review L2).
  const connectionsKey = (connections ?? []).map((c) => `${c.connection.id}:${c.status.state}:${c.connection.enabled === false ? 0 : 1}`).join('|')
  useEffect(() => {
    if (loaded) loadLibrary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionsKey])

  // Each project with servers of its own: one mcp.list per project per session, through the shared queue.
  const wanted = useMemo(() => projectsWithOwnServers(projects), [projects])
  const wantedKey = wanted.join('\u0000')
  useEffect(() => {
    if (!loaded) return
    let live = true
    for (const id of wanted) {
      const project = projects.find((p) => p.id === id)
      if (!project) continue
      void projectQueue.enqueue<McpServerInfo[]>('mcpList', id, () => window.orgai.mcp.list(id)).then((infos) => {
        if (!live) return
        setServerRows((prev) => ({ ...prev, [id]: infos ? projectServerRows(project, infos) : [] }))
      })
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, wantedKey])

  const rows = useMemo<SetupRow[]>(() => {
    const needed = connectionsNeeded(connections, defaultConnection, projects, !!mockAdapter)
    const projectIds = new Set(projects.map((p) => p.id))
    return orderSetupRows([
      ...connectionProblems(connections, needed.inUse, needed.projects).map(connectionRow),
      ...libraryRows(library, connectors),
      ...Object.entries(serverRows)
        .filter(([id]) => projectIds.has(id))
        .flatMap(([, r]) => r)
    ])
  }, [connections, defaultConnection, projects, mockAdapter, library, connectors, serverRows])

  const setView = useAppStore((s) => s.setView)
  const openMcpLibrary = useAppStore((s) => s.openMcpLibrary)
  const openProjectMcp = useAppStore((s) => s.openProjectMcp)
  const go = (target: SetupTarget): void => {
    switch (target.type) {
      case 'connections':
        requestAppSettingsSection(APP_SETTINGS_PANES.connections)
        setView('appSettings')
        return
      case 'connector':
        requestConnector(target.connectorId)
        setView('appSettings')
        return
      case 'library':
        openMcpLibrary(target.libraryId)
        return
      case 'project':
        openProjectMcp(target.projectId, target.serverId)
        return
    }
  }

  if (rows.length === 0) return null
  const word = rows.length === 1 ? '1 thing to set up' : `${rows.length} things to set up`
  return (
    <Popover
      trigger={
        <>
          <Icon icon={ListTodo} size="sm" />
          {word}
        </>
      }
      triggerClassName="btn ghost sm dash-setup-line"
      triggerTestId="dash-setup-line"
      label="To set up"
      className="dash-setup-panel"
      testId="dash-setup"
    >
      <ul className="dash-setup-rows">
        {rows.map((r) => (
          <li key={`${r.kind}/${r.id}`} className="dash-setup-row" data-testid="dash-setup-row" data-kind={r.kind} data-id={r.id}>
            <div className="dash-setup-text">
              <span className="dash-setup-line-text" title={r.line}>
                {r.line}
              </span>
              {r.caption && (
                <span className="dash-setup-caption" title={r.caption}>
                  {r.caption}
                </span>
              )}
            </div>
            <Button variant="secondary" size="sm" testId="dash-setup-action" ariaLabel={`${r.action}: ${r.line}`} onClick={() => go(r.target)}>
              {r.action}
            </Button>
          </li>
        ))}
      </ul>
    </Popover>
  )
}
