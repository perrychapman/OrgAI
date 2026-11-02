import type { ReactElement } from 'react'
import { useId } from 'react'
import { Check, Minus, Pencil, Plus, TriangleAlert } from 'lucide-react'
import type { McpServerSpec, McpServersProposalPayload } from '@shared/types'
import { clampLabel } from '../../lib/clampLabel'
import {
  codeLoadingEnv,
  diffMcpProposal,
  effectLine,
  mcpFieldChanges,
  mcpServerHidden,
  pinState,
  proposalScope,
  proposalSource,
  proposalTarget,
  secretSlotNames,
  uniqueSecretSlots,
  upsertAction,
  whoCanUse,
  whoCanUseChange,
  type McpChange,
  type McpRow,
  type McpSecretSlot,
  type RoleRef
} from '../../lib/mcpProposal'
import { Badge } from '../ui/Badge'
import { Input } from '../ui/Input'
import { CopyButton } from '../ui/CopyButton'
import { ClampText } from './ClampText'
import type { McpCurrent } from './useCurrent'

type Payload = McpServersProposalPayload

/** Secret values the user typed, keyed by the slot's index in payload.secrets. They live in the card's state only. */
export type SecretValues = Record<number, string>

const BADGE: Record<Exclude<McpChange, 'same'>, { text: string; tone: 'success' | 'info' | 'warning'; icon: typeof Plus }> = {
  new: { text: 'New', tone: 'success', icon: Plus },
  link: { text: 'From library', tone: 'info', icon: Plus },
  access: { text: 'Changed', tone: 'warning', icon: Pencil },
  update: { text: 'Changed', tone: 'warning', icon: Pencil }
}

function SecretField({ slot, forServer, value, onChange }: { slot: McpSecretSlot; forServer?: string; value: string; onChange: (v: string) => void }): ReactElement {
  const id = useId()
  const hintId = `${id}-hint`
  const name = clampLabel(slot.name, 60)
  return (
    <div className="mcp-prop-secret" data-testid="mcp-proposal-secret" data-secret={name} data-server-id={clampLabel(slot.serverId, 60)} data-kind={slot.kind}>
      <label htmlFor={id} className="mcp-prop-secret-label">
        {name}
        {forServer ? ` for ${forServer}` : ''} <span className="muted">(optional, set it later if you prefer)</span>
      </label>
      <Input id={id} type="password" mono autoComplete="off" value={value} onChange={onChange} aria-describedby={slot.description ? hintId : undefined} />
      {slot.description && (
        <span id={hintId} className="mcp-prop-secret-hint">
          {clampLabel(slot.description, 160)}
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
  slots,
  secretValues,
  setSecret
}: {
  row: McpRow
  payload: Payload
  roles: RoleRef[]
  libraryCommand: McpServerSpec | null
  slots: { index: number; slot: McpSecretSlot }[]
  secretValues: SecretValues
  setSecret: (index: number, v: string) => void
}): ReactElement {
  const s = row.server
  const scope = proposalScope(payload)
  const badge = BADGE[row.change]
  const pin = row.change === 'new' ? pinState(s) : null
  const target = proposalTarget(s, libraryCommand)
  const source = proposalSource(s)
  const who = row.change === 'access' || row.change === 'update' ? whoCanUseChange(s, row.current, roles) : whoCanUse(s, roles, scope)
  const hidden = mcpServerHidden(s, libraryCommand)
  const loads = codeLoadingEnv(s).length > 0 || (!!libraryCommand && s.libraryId !== undefined && codeLoadingEnv(libraryCommand).length > 0)
  const changes = row.change === 'update' && row.current ? mcpFieldChanges(s, row.current) : []
  const secretNames = secretSlotNames(s.libraryId && !s.command && !s.url && libraryCommand ? libraryCommand : s)
  const name = clampLabel(s.name, 60)
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
        {loads && (
          <Badge tone="danger" icon={TriangleAlert} testId="mcp-proposal-loads">
            Changes what runs
          </Badge>
        )}
        {hidden && (
          <Badge tone="danger" icon={TriangleAlert} testId="mcp-proposal-hidden">
            Contains hidden characters
          </Badge>
        )}
      </div>
      {s.description && <ClampText text={s.description} label={name} />}
      {source && <div className="mcp-prop-source muted">{source}</div>}
      {target && (
        <div className="mcpi-command">
          <div className="code-block" data-testid="mcp-proposal-command" title={target}>
            {target}
          </div>
          <CopyButton text={target} label={`${s.transport === 'stdio' ? 'Copy command' : 'Copy URL'} for ${name}`} />
        </div>
      )}
      {changes.length > 0 && (
        <ul className="mcp-prop-effects" data-testid="mcp-proposal-changes" aria-label={`What changes in ${name}`}>
          {changes.map((c, i) => (
            <li key={i}>{clampLabel(c, 400)}</li>
          ))}
        </ul>
      )}
      <ul className="mcp-prop-effects">
        <li>{effectLine(s)}</li>
        {who && <li>Who can use it: {who}</li>}
        {secretNames.length > 0 && (
          <li>
            {s.transport === 'stdio' ? 'Secret environment' : 'Secret headers'} (names only): {secretNames.map((n) => clampLabel(n, 40)).join(', ')}
          </li>
        )}
      </ul>
      {slots.map(({ index, slot }) => (
        <SecretField key={index} slot={slot} value={secretValues[index] ?? ''} onChange={(v) => setSecret(index, v)} />
      ))}
    </div>
  )
}

/** The body of an mcpServers proposal: a summary against what the project has, then New, Link, Changed and Remove rows. */
export function McpProposalBody({
  payload,
  current,
  roles,
  secretValues,
  setSecret
}: {
  payload: Payload
  /** What the card compares against (read through the preload). */
  current: McpCurrent
  roles: RoleRef[]
  secretValues: SecretValues
  setSecret: (index: number, v: string) => void
}): ReactElement {
  const scope = proposalScope(payload)
  if (current.status === 'loading') {
    return (
      <div className="mcp-prop">
        <p className="mcp-prop-checking muted" data-testid="proposal-checking">
          Checking current servers…
        </p>
      </div>
    )
  }
  const diff = diffMcpProposal(payload, current.servers, roles)
  const unique = uniqueSecretSlots(payload)
  const rowIds = new Set(diff.rows.map((r) => r.server.id))
  const orphans = unique.filter((x) => !rowIds.has(x.slot.serverId))
  const unchangedNames = [...(diff.untouched ?? []), ...diff.same]
  const readError = current.failed.library ? 'Could not read your library; changes may show as new.' : current.failed.servers ? 'Could not read this project’s servers; changes may show as new.' : null
  return (
    <div className="mcp-prop">
      <div className="mcp-prop-scope">
        <Badge tone="info" testId="mcp-proposal-scope">
          {scope === 'library' ? 'Library' : 'This project'}
        </Badge>
        <span className="mcp-prop-scope-note">{scope === 'library' ? 'Changes your MCP library' : 'Changes this project’s MCP servers'}</span>
      </div>
      {readError && (
        <p className="proposal-read-error" role="status" data-testid="proposal-read-error">
          <TriangleAlert size={14} aria-hidden="true" /> {readError}
        </p>
      )}
      <p className="proposal-summary" data-testid="proposal-summary">
        {diff.summary}
      </p>
      <ClampText text={payload.rationale} label="the explanation" />
      {diff.rows.map((row) => (
        <ServerRow
          key={row.server.id}
          row={row}
          payload={payload}
          roles={roles}
          libraryCommand={current.library?.find((e) => e.id === row.server.libraryId) ?? null}
          slots={unique.filter((x) => x.slot.serverId === row.server.id)}
          secretValues={secretValues}
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
      {orphans.length > 0 && (
        <div className="mcp-prop-server" data-testid="mcp-proposal-secrets">
          <div className="mcp-prop-head">
            <strong>Secrets</strong>
          </div>
          {orphans.map(({ index, slot }) => (
            <SecretField key={index} slot={slot} forServer={clampLabel(slot.serverId, 40)} value={secretValues[index] ?? ''} onChange={(v) => setSecret(index, v)} />
          ))}
        </div>
      )}
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
