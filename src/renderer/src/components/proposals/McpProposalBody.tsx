import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { Check, Minus, Pencil, Plus, TriangleAlert } from 'lucide-react'
import type { McpSecretKind, McpServerSpec, McpServersProposalPayload } from '@shared/types'
import { clampLabel } from '../../lib/clampLabel'
import {
  diffMcpProposal,
  effectLine,
  pinState,
  proposalCommand,
  proposalScope,
  proposalSource,
  secretsLine,
  upsertAction,
  whoCanUse,
  whoCanUseChange,
  type McpChange,
  type McpRow,
  type RoleRef
} from '../../lib/mcpProposal'
import { Badge } from '../ui/Badge'
import { Input } from '../ui/Input'
import { CopyButton } from '../ui/CopyButton'
import { ClampText } from './ClampText'

type Payload = McpServersProposalPayload

export type SecretValue = { serverId: string; kind: McpSecretKind; name: string; value: string }

/** Second pass: inline secret fields on the card. Values stay in component state and leave only through onChange. */
export interface SecretInputs {
  onChange: (values: SecretValue[]) => void
}

const BADGE: Record<Exclude<McpChange, 'same'>, { text: string; tone: 'success' | 'info' | 'warning'; icon: typeof Plus }> = {
  new: { text: 'New', tone: 'success', icon: Plus },
  link: { text: 'From library', tone: 'info', icon: Plus },
  access: { text: 'Changed', tone: 'warning', icon: Pencil },
  update: { text: 'Changed', tone: 'warning', icon: Pencil }
}

function SecretField({ serverId, kind, name, description, value, onChange }: { serverId: string; kind: McpSecretKind; name: string; description?: string; value: string; onChange: (v: string) => void }): ReactElement {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="mcp-prop-secret" data-testid="mcp-proposal-secret" data-secret={clampLabel(name, 60)} data-server-id={serverId} data-kind={kind}>
      <label htmlFor={id} className="mcp-prop-secret-label">
        {clampLabel(name, 60)} <span className="muted">(optional, set it later if you prefer)</span>
      </label>
      <Input id={id} type="password" mono autoComplete="off" value={value} onChange={onChange} aria-describedby={description ? hintId : undefined} />
      {description && (
        <span id={hintId} className="mcp-prop-secret-hint">
          {clampLabel(description, 160)}
        </span>
      )}
    </div>
  )
}

function ServerRow({
  row,
  payload,
  roles,
  libraryCommand,
  secretInputs,
  secretValues,
  setSecret
}: {
  row: McpRow
  payload: Payload
  roles: RoleRef[]
  libraryCommand: McpServerSpec | null
  secretInputs?: SecretInputs
  secretValues: Record<string, string>
  setSecret: (serverId: string, kind: McpSecretKind, name: string, v: string) => void
}): ReactElement {
  const s = row.server
  const scope = proposalScope(payload)
  const badge = BADGE[row.change]
  const pin = row.change === 'new' ? pinState(s) : null
  const slots = (payload.secrets ?? []).filter((x) => x.serverId === s.id)
  const cmd = proposalCommand(s, libraryCommand)
  const source = proposalSource(s)
  const who = row.change === 'access' || row.change === 'update' ? whoCanUseChange(s, row.current, roles) : whoCanUse(s, roles, scope)
  const secrets = secretInputs ? null : secretsLine(payload, s.id)
  return (
    <div className="mcp-prop-server" data-testid="mcp-proposal-server" data-server={clampLabel(s.name)} data-change={row.change}>
      <div className="mcp-prop-head">
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.text}
        </Badge>
        <strong>{upsertAction(s, scope)}</strong>
        {scope === 'project' && s.projectOnly && !s.libraryId && <Badge tone="neutral">Project only</Badge>}
        {pin === 'pinned' && (
          <Badge tone="success" icon={Check}>
            Pinned
          </Badge>
        )}
        {pin === 'unpinned' && (
          <Badge tone="danger" icon={TriangleAlert}>
            Version not pinned
          </Badge>
        )}
      </div>
      {s.description && <ClampText text={s.description} />}
      {source && <div className="mcp-prop-source muted">{source}</div>}
      {cmd && (
        <div className="mcpi-command">
          <div className="code-block" data-testid="mcp-proposal-command" title={cmd}>
            {cmd}
          </div>
          <CopyButton text={cmd} label={s.transport === 'stdio' ? 'Copy command' : 'Copy URL'} />
        </div>
      )}
      <ul className="mcp-prop-effects">
        <li>{effectLine(s)}</li>
        {who && <li>Who can use it: {who}</li>}
        {secrets && <li>{secrets}</li>}
      </ul>
      {secretInputs && slots.map((x) => <SecretField key={`${x.kind}:${x.name}`} serverId={x.serverId} kind={x.kind} name={x.name} description={x.description} value={secretValues[`${x.serverId}|${x.kind}|${x.name}`] ?? ''} onChange={(v) => setSecret(x.serverId, x.kind, x.name, v)} />)}
    </div>
  )
}

/** The body of an mcpServers proposal: a summary against what the project has, then New, Link, Changed and Remove rows. */
export function McpProposalBody({
  payload,
  current,
  roles,
  library,
  secretInputs
}: {
  payload: Payload
  /** The project's servers (library scope: the library's entries); null while unknown. */
  current: readonly McpServerSpec[] | null
  roles: RoleRef[]
  /** Library entries, for a link row's command. */
  library: readonly McpServerSpec[] | null
  secretInputs?: SecretInputs
}): ReactElement {
  const scope = proposalScope(payload)
  const diff = diffMcpProposal(payload, current, roles)
  const [values, setValues] = useState<Record<string, string>>({})
  const setSecret = (serverId: string, kind: McpSecretKind, name: string, v: string): void => {
    const next = { ...values, [`${serverId}|${kind}|${name}`]: v }
    setValues(next)
    secretInputs?.onChange(
      Object.entries(next)
        .filter(([, val]) => val !== '')
        .map(([key, value]) => {
          const [sid, k, ...n] = key.split('|')
          return { serverId: sid, kind: k as McpSecretKind, name: n.join('|'), value }
        })
    )
  }
  const unchangedNames = [...(diff.untouched ?? []), ...diff.same]
  return (
    <div className="mcp-prop">
      <div className="mcp-prop-scope">
        <Badge tone="info" testId="mcp-proposal-scope">
          {scope === 'library' ? 'Library' : 'This project'}
        </Badge>
        <span className="mcp-prop-scope-note">{scope === 'library' ? 'Changes your MCP library' : 'Changes this project’s MCP servers'}</span>
      </div>
      <p className="proposal-summary" data-testid="proposal-summary">
        {diff.summary}
      </p>
      <ClampText text={payload.rationale} />
      {diff.rows.map((row) => (
        <ServerRow
          key={row.server.id}
          row={row}
          payload={payload}
          roles={roles}
          libraryCommand={library?.find((e) => e.id === row.server.libraryId) ?? null}
          secretInputs={secretInputs}
          secretValues={values}
          setSecret={setSecret}
        />
      ))}
      {diff.removals.map((r) => (
        <div key={r.id} className="mcp-prop-server" data-testid="mcp-proposal-removal" data-server={r.name} data-change="remove">
          <div className="mcp-prop-head">
            <Badge tone="danger" icon={Minus}>
              Remove
            </Badge>
            <strong>{r.title}</strong>
          </div>
          {(r.detail || r.note) && (
            <ul className="mcp-prop-effects">
              {r.detail && <li>{r.detail}</li>}
              {r.note && <li>{r.note}</li>}
            </ul>
          )}
        </div>
      ))}
      {unchangedNames.length > 0 && (
        <details className="org-diff-unchanged" data-testid="mcp-proposal-unchanged">
          <summary>
            {unchangedNames.length} unchanged {unchangedNames.length === 1 ? 'server' : 'servers'}
          </summary>
          <ul className="proposal-list">
            {unchangedNames.map((n, i) => (
              <li key={`${n}-${i}`}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
