import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import type { McpInstallOutcome, McpInstallRequest } from '@shared/types'
import DecisionCard from './DecisionCard'
import { Badge } from './ui/Badge'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { CopyButton } from './ui/CopyButton'
import { Icon } from './ui/Icon'
import { Textarea } from './ui/Textarea'
import { SecretField } from './ui/SecretField'
import { pinnedVersionOf } from '../lib/mcpVersion'

/** The exact command line (stdio) or endpoint (http/sse) the server would run, never shortened. */
export function installCommand(request: McpInstallRequest): string {
  const { spec } = request
  if (spec.transport === 'stdio') return [spec.command ?? '', ...(spec.args ?? [])].filter(Boolean).join(' ')
  return spec.url ?? ''
}

function describeOutcome(o: McpInstallOutcome): string {
  if (o.approved) return o.scope === 'library' ? 'Approved for this project and your library' : o.scope === 'project' ? 'Approved for this project' : 'Approved for this run'
  return o.note ? `Denied. Note sent: ${o.note}` : 'Denied'
}

/**
 * Approval card for an agent's request_mcp_install. Untrusted input (reason, command) is rendered as plain text.
 * `collapsed` shows a one-line header (the live region shows one expanded card at a time); `onExpand` opens it.
 * `onDismiss` removes a resolved card from the region.
 */
export default function McpInstallCard({
  runId,
  request,
  agentName,
  resolved,
  collapsed,
  onExpand,
  onDismiss
}: {
  runId: string
  request: McpInstallRequest
  agentName: string
  resolved?: McpInstallOutcome
  collapsed?: boolean
  onExpand?: () => void
  onDismiss?: () => void
}): ReactElement {
  const uid = useId()
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [scope, setScope] = useState<'run' | 'project' | 'library'>('run')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  const { spec } = request
  const registryName = request.registry?.name ?? spec.registry?.name
  const command = installCommand(request)
  const version = pinnedVersionOf(spec)
  const remote = spec.transport !== 'stdio'
  const unpinned = !remote && !version
  const time = new Date(request.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const title = `${agentName} wants to install an MCP server`

  const answer = async (approved: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.orgai.mcp.answerInstall({
        runId,
        requestId: request.id,
        decision: approved
          ? { approved: true, secrets: Object.keys(secrets).length > 0 ? secrets : undefined, note: note.trim() || undefined, scope }
          : { approved: false, note: note.trim() || undefined, scope: 'run' }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The answer could not be delivered.')
    } finally {
      setBusy(false)
    }
  }

  const shell = (children: ReactElement): ReactElement => (
    <div className="mcp-install" data-testid="mcp-install-card" data-request={request.id}>
      {children}
    </div>
  )

  if (resolved) {
    return shell(
      <DecisionCard
        kind="install"
        runId={runId}
        who={agentName}
        title={spec.name}
        noAutoFocus
        headerExtra={<Badge tone={resolved.approved ? 'success' : 'danger'}>{resolved.approved ? 'Approved' : 'Denied'}</Badge>}
        primary={
          onDismiss ? (
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : undefined
        }
      >
        <div className="mcpi-resolved">
          <span className={`mcpi-resolved-icon ${resolved.approved ? 'ok' : 'denied'}`}>
            <Icon icon={resolved.approved ? Check : X} size="sm" />
          </span>
          <span className="mcpi-resolved-text">{describeOutcome(resolved)}</span>
        </div>
      </DecisionCard>
    )
  }

  if (collapsed) {
    return shell(
      <DecisionCard
        kind="install"
        runId={runId}
        who={agentName}
        title={title}
        noAutoFocus
        headerExtra={<Badge tone="warning">Needs you</Badge>}
        primary={
          <Button size="sm" icon={ChevronDown} onClick={onExpand}>
            Review
          </Button>
        }
      />
    )
  }

  const reason = request.reason.trim()
  const longReason = reason.length > 240 || reason.split('\n').length > 4

  return shell(
    <DecisionCard
      kind="install"
      runId={runId}
      who={agentName}
      title={title}
      headerExtra={
        <span className="mcpi-meta">
          <span className="tabular">{time}</span>
          <Badge tone="warning">Needs you</Badge>
        </span>
      }
      helper={unpinned ? <span className="mcpi-reason-disabled">Only pinned versions can be approved. Runs code on this machine.</span> : 'Approving runs code on this machine. Scope below decides how long it stays.'}
      primary={
        <Button variant="primary" size="sm" loading={busy} disabled={unpinned} title={unpinned ? 'Only pinned versions can be approved' : undefined} onClick={() => void answer(true)}>
          {busy ? 'Installing...' : error ? 'Retry' : 'Approve'}
        </Button>
      }
      deny={
        <Button variant="danger" size="sm" disabled={busy} onClick={() => void answer(false)}>
          Deny
        </Button>
      }
    >
      <div className="mcpi-body">
        <div className="mcpi-sec">
          <div className="mcpi-label">Why</div>
          <p className={`mcpi-reason ${more ? '' : 'clamped'}`}>{reason || 'No reason given.'}</p>
          {longReason && (
            <button type="button" className="mcpi-link" aria-expanded={more} onClick={() => setMore((v) => !v)}>
              {more ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>

        <Banner tone="warning">
          {remote
            ? 'This connects to a remote server that will receive the data the agent sends it.'
            : 'This runs code on this machine with your permissions. Only approve servers you trust.'}
        </Banner>

        <div className="mcpi-sec">
          <div className="mcpi-label">{remote ? 'Endpoint' : 'Command'}</div>
          <div className="mcpi-command">
            <div className="code-block" data-testid="mcp-install-command">
              {command}
            </div>
            <CopyButton text={command} label="Copy command" />
          </div>
        </div>

        <dl className="mcpi-facts">
          <div>
            <dt>Version</dt>
            <dd>
              {remote ? (
                <span className="muted">Hosted by the remote server</span>
              ) : version ? (
                <span className="mono">{version}</span>
              ) : (
                <Badge tone="danger">Not pinned</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{registryName ? <span>Registry: {registryName}</span> : <span className="mcpi-warn">Typed by the agent</span>}</dd>
          </div>
          <div>
            <dt>Transport</dt>
            <dd className="mono">{spec.transport}</dd>
          </div>
        </dl>

        <div className="mcpi-cols">
          {request.requiredSecrets.length > 0 && (
            <div className="mcpi-sec">
              <div className="mcpi-label">Secrets</div>
              {request.requiredSecrets.map((name) => (
                <div key={name} className="mcpi-secret">
                  <div className="mcpi-secret-name mono">{name}</div>
                  <SecretField
                    name={name}
                    state={secrets[name] ? 'set' : 'notSet'}
                    disabled={busy}
                    onSave={(value) => setSecrets((cur) => ({ ...cur, [name]: value }))}
                    onClear={() =>
                      setSecrets((cur) => {
                        const next = { ...cur }
                        delete next[name]
                        return next
                      })
                    }
                  />
                  {!secrets[name] && <div className="mcpi-warn">Not set. The server may not work.</div>}
                </div>
              ))}
            </div>
          )}

          <fieldset className="mcpi-sec mcpi-scope" disabled={busy}>
            <legend className="mcpi-label">Scope</legend>
            {(
              [
                ['run', 'This run only', 'Available until this run ends, then removed.'],
                ['project', 'This project', 'Saved to this project’s MCP servers and kept for later runs.'],
                ['library', 'This project and library', 'Saved to your MCP library and enabled for this project.']
              ] as const
            ).map(([value, name, desc]) => (
              <label key={value} className={`mcpi-radio ${scope === value ? 'on' : ''}`}>
                <input type="radio" data-testid={`mcp-install-scope-${value}`} name={`${uid}-scope`} value={value} checked={scope === value} onChange={() => setScope(value)} />
                <span>
                  <span className="mcpi-radio-name">{name}</span>
                  <span className="mcpi-radio-desc">{desc}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>

        <div className="field mcpi-note">
          <label htmlFor={`${uid}-note`}>Note to the agent (optional)</label>
          <Textarea id={`${uid}-note`} rows={2} value={note} disabled={busy} onChange={setNote} />
        </div>

        {error && (
          <Banner tone="danger" title="The install failed">
            {error}
          </Banner>
        )}
      </div>

    </DecisionCard>
  )
}
