import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { Bot, CircleAlert, Package, ShieldAlert, ShieldCheck, ShieldX, User } from 'lucide-react'
import type { McpAuthStatus, McpAuthTarget, McpServerSource } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { errMessage } from './mcpHelpers'
import { relativeTime } from './mcpLibraryHelpers'

/** Authorization state as icon + words (never color alone). Renders nothing for servers that need no sign-in. */
export function AuthChip({ auth }: { auth: McpAuthStatus }): ReactElement | null {
  if (auth.state === 'notRequired') return null
  const expiry = auth.state === 'authorized' ? relativeTime(auth.expiresAt) : undefined
  return (
    <span className="mcp-auth" data-testid="mcp-auth-status" data-state={auth.state}>
      {auth.state === 'notAuthorized' && (
        <Badge tone="warning" icon={ShieldAlert}>
          Not authorized
        </Badge>
      )}
      {auth.state === 'authorized' && (
        <Badge tone="success" icon={ShieldCheck}>
          Authorized
        </Badge>
      )}
      {auth.state === 'expired' && (
        <Badge tone="warning" icon={ShieldX}>
          Expired
        </Badge>
      )}
      {auth.state === 'error' && (
        <Badge tone="danger" icon={CircleAlert}>
          Authorization failed
        </Badge>
      )}
      {auth.state === 'authorized' && auth.account && <span className="muted mcp-auth-detail">as {auth.account}</span>}
      {expiry && <span className="muted mcp-auth-detail">expires {expiry}</span>}
      {auth.state === 'error' && auth.error && <span className="invalid-text mcp-auth-detail">{auth.error}</span>}
    </span>
  )
}

/**
 * Authorize / Reauthorize / Try again for a remote server, with the pending state ("Waiting for your browser…" and
 * Cancel) and, when the authorization server has no dynamic registration, write-only client id and secret inputs.
 * The client secret lives in state only until the call settles.
 */
export function AuthorizeControl({
  target,
  auth,
  serverName,
  variant = 'secondary',
  onChanged
}: {
  target: McpAuthTarget
  auth: McpAuthStatus
  serverName: string
  variant?: 'primary' | 'secondary'
  onChanged?: (status: McpAuthStatus) => void
}): ReactElement | null {
  const id = useId()
  const [pending, setPending] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [last, setLast] = useState<McpAuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = last ?? auth
  const needsClient = shown.needsClientId === true || auth.needsClientId === true

  if (auth.state === 'notRequired' || auth.state === 'authorized') return null

  const label = shown.state === 'expired' ? 'Reauthorize' : shown.state === 'error' ? 'Try again' : 'Authorize'

  const start = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const withClient = needsClient && clientId.trim() ? { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) } : {}
      const status = await window.orgai.mcp.authorize({ ...target, ...withClient })
      setLast(status)
      if (status.state === 'authorized') {
        setClientId('')
        onChanged?.(status)
      } else if (status.state === 'error') onChanged?.(status)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setClientSecret('')
      setPending(false)
    }
  }
  const cancel = (): void => {
    void window.orgai.mcp.cancelAuthorize(target).catch(() => undefined)
  }

  if (pending)
    return (
      <div className="mcp-authorize" data-testid="mcp-authorize-pending">
        <span className="muted" role="status">
          Waiting for your browser…
        </span>
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    )

  return (
    <div className="mcp-authorize">
      {needsClient && (
        <div className="mcp-client-inputs" role="group" aria-label={`OAuth app for ${serverName}`}>
          <p className="muted">This server needs a pre-registered OAuth app. Create one with the provider, then enter its client ID here.</p>
          <div className="field mcp-field">
            <label htmlFor={`${id}-cid`}>Client ID</label>
            <Input id={`${id}-cid`} mono value={clientId} autoComplete="off" spellCheck={false} onChange={setClientId} />
          </div>
          <div className="field mcp-field">
            <label htmlFor={`${id}-sec`}>Client secret (optional)</label>
            <Input id={`${id}-sec`} mono type="password" value={clientSecret} autoComplete="off" spellCheck={false} onChange={setClientSecret} />
            <span className="hint">Stored encrypted on this machine and never shown again.</span>
          </div>
        </div>
      )}
      <div className="mcp-authorize-row">
        <Button size="sm" variant={variant} testId="mcp-library-authorize" ariaLabel={`${label} ${serverName}`} disabled={needsClient && !clientId.trim()} onClick={() => void start()}>
          {label}
        </Button>
      </div>
      {shown.state === 'error' && shown.error && !needsClient && (
        <p className="invalid-text mcp-auth-error" role="alert">
          {shown.error}
        </p>
      )}
      {error && (
        <p className="invalid-text mcp-auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Where a server came from. 'library' (a linked project row) has its own Library badge in the row. */
export function SourceBadge({ source }: { source: McpServerSource }): ReactElement {
  if (source === 'registry')
    return (
      <Badge tone="info" icon={Package}>
        Registry
      </Badge>
    )
  if (source === 'agent')
    return (
      <Badge tone="warning" icon={Bot} title="An agent requested this server and you approved it.">
        Agent
      </Badge>
    )
  return <Badge icon={User}>You</Badge>
}
