import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { McpServerInfo, Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { authWarning } from './mcpLibraryHelpers'

/**
 * Non-blocking warning for the start area: enabled remote servers of the project that are not authorized or have
 * expired, so agents cannot use them. In flow, above the composer. Renders nothing when everything is fine.
 */
export default function McpAuthNotice({ project }: { project: Project }): ReactElement | null {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  useEffect(() => {
    let live = true
    const load = (): void => {
      window.orgai.mcp
        .list(project.id)
        .then((list) => live && setServers(list))
        .catch(() => undefined)
    }
    load()
    const off = window.orgai.onMcpLibraryChanged(load)
    return () => {
      live = false
      off()
    }
  }, [project.id, project.mcpServers])
  const warnings = authWarning(servers)
  if (warnings.length === 0) return null
  return (
    <Banner
      tone="warning"
      testId="mcp-auth-notice"
      title={warnings.length === 1 ? `${warnings[0].name} is not authorized` : `${warnings.length} MCP servers are not authorized`}
      actions={warnings.map((w) => (
        <Button key={w.id} size="sm" onClick={() => useAppStore.getState().openProjectMcp(project.id, w.id)}>
          {w.expired ? 'Reauthorize' : 'Authorize'} {w.name}
        </Button>
      ))}
    >
      {warnings.map((w) => w.name).join(', ')} {warnings.length === 1 ? 'is' : 'are'} {warnings.every((w) => w.expired) ? 'expired' : 'not authorized'}; agents will not be able to use{' '}
      {warnings.length === 1 ? 'it' : 'them'}. You can still start the run.
    </Banner>
  )
}
