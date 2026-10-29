import type { ReactElement } from 'react'
import type { McpInstallOutcome, McpInstallRequest } from '@shared/types'

/** Stub: the UI Engineer replaces this with the install approval card. */
export default function McpInstallCard({
  request
}: {
  runId: string
  request: McpInstallRequest
  agentName: string
  resolved?: McpInstallOutcome
}): ReactElement {
  return <div data-testid="mcp-install-card" data-request={request.id} />
}
