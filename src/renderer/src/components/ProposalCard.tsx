import type { ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import { Minus, Pencil, Plus } from 'lucide-react'
import type { Proposal, ProposalDecision, Role } from '@shared/types'
import { PERMISSION_MODE_OPTIONS } from '@shared/types'
import { initials } from '../lib/layout'
import { diffOrgChart, type ChangedRole, type DiffRole } from '../lib/orgDiff'
import DecisionCard from './DecisionCard'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Textarea } from './ui/Textarea'

interface Props {
  proposal: Proposal
  /** The run the proposal belongs to (named above the card header). */
  runId: string
  /** The project's current roles, for the org-chart diff. */
  currentRoles: Role[]
  /** The proposing agent's display name, when known. */
  who?: string
  onDecide: (decision: ProposalDecision) => void
}

const KIND_LABEL: Record<Proposal['kind'], string> = {
  architecture: 'Architecture',
  orgChart: 'Org chart',
  settings: 'Run settings',
  mcpServers: 'MCP servers'
}

const APPLY_NOTE: Record<Proposal['kind'], string> = {
  architecture: 'Approving writes .orgai/ARCHITECTURE.md into the working directory and references it from CLAUDE.md.',
  orgChart: 'Approving replaces the project’s org chart with these roles. You can still edit them by hand afterwards.',
  settings: 'Approving updates the project settings and brief, and saves any allowed commands to .claude/settings.local.json.',
  mcpServers: 'Approving saves these MCP servers to the project. Secrets are entered separately and stored encrypted.'
}

export default function ProposalCard({ proposal, runId, currentRoles, who, onDecide }: Props): ReactElement {
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

  const approve = (): void => {
    setBusy(true)
    onDecide({ behavior: 'approve' })
  }
  const revise = (): void => {
    if (!feedback.trim()) return
    setBusy(true)
    onDecide({ behavior: 'revise', feedback: feedback.trim() })
  }

  // No Reject: ProposalDecision only has approve and revise.
  return (
    <DecisionCard
      kind="proposal"
      runId={runId}
      who={who}
      title={`${KIND_LABEL[proposal.kind]}: ${proposal.title}`}
      helper={APPLY_NOTE[proposal.kind]}
      primary={
        !revising ? (
          <Button variant="primary" onClick={approve} disabled={busy}>
            Approve
          </Button>
        ) : (
          <Button variant="primary" onClick={revise} disabled={busy || !feedback.trim()}>
            Send feedback
          </Button>
        )
      }
      secondary={
        !revising ? (
          <Button onClick={() => setRevising(true)} disabled={busy}>
            Request changes
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setRevising(false)} disabled={busy}>
            Back
          </Button>
        )
      }
    >
      {proposal.kind === 'architecture' && <ArchitectureBody payload={proposal.payload} />}
      {proposal.kind === 'orgChart' && <OrgChartBody payload={proposal.payload} currentRoles={currentRoles} />}
      {proposal.kind === 'settings' && <SettingsBody payload={proposal.payload} />}
      {proposal.kind === 'mcpServers' && <McpServersBody payload={proposal.payload} />}
      {revising && (
        <div className="proposal-feedback">
          <Textarea
            autoFocus
            aria-label="What should change?"
            value={feedback}
            onChange={setFeedback}
            placeholder="What should change? The Architect revises and proposes again."
          />
        </div>
      )}
    </DecisionCard>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="proposal-section">
      <div className="proposal-section-title">{title}</div>
      {children}
    </div>
  )
}

function ArchitectureBody({ payload }: { payload: Extract<Proposal, { kind: 'architecture' }>['payload'] }): ReactElement {
  return (
    <>
      <p className="proposal-lead">{payload.summary}</p>
      {payload.stack.length > 0 && (
        <Section title="Stack">
          <div className="proposal-chips">
            {payload.stack.map((s, i) => (
              <span key={i} className="chip proposal-chip">
                {s}
              </span>
            ))}
          </div>
        </Section>
      )}
      {payload.modules.length > 0 && (
        <Section title="Modules">
          <ul className="proposal-list">
            {payload.modules.map((m, i) => (
              <li key={i}>
                <strong>{m.name}</strong> {m.purpose}
                {m.paths.length > 0 && <div className="mono-dim">{m.paths.join(', ')}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {payload.conventions.length > 0 && (
        <Section title="Conventions">
          <ul className="proposal-list">
            {payload.conventions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </Section>
      )}
      {payload.commands.length > 0 && (
        <Section title="Commands">
          <ul className="proposal-list">
            {payload.commands.map((c, i) => (
              <li key={i}>
                {c.name}: <code>{c.command}</code>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {payload.risks.length > 0 && (
        <Section title="Risks and gaps">
          <ul className="proposal-list">
            {payload.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

type PayloadRole = Extract<Proposal, { kind: 'orgChart' }>['payload']['roles'][number]

function parentLabel(r: DiffRole, all: readonly DiffRole[]): string {
  return r.reportsTo ? (all.find((x) => x.id === r.reportsTo)?.name ?? 'none') : 'root'
}

function RoleAvatar({ role }: { role: PayloadRole }): ReactElement {
  return (
    <span className="avatar org-diff-avatar" style={{ ['--role' as string]: role.color }} aria-hidden="true">
      {initials(role.name)}
    </span>
  )
}

function AddedRow({ role, all }: { role: PayloadRole; all: PayloadRole[] }): ReactElement {
  return (
    <details className="org-diff-row is-added">
      <summary>
        <Badge tone="success" icon={Plus}>
          Added
        </Badge>
        <RoleAvatar role={role} />
        <span className="org-diff-name">{role.name}</span>
        <span className="org-diff-meta">
          reports to {parentLabel(role, all)} · {role.model}
          {role.canSpawn ? ` · leads ${role.spawnable.length}` : ''}
        </span>
      </summary>
      <div className="proposal-role-body">
        <div>{role.description}</div>
        <div className="mono-dim">tools: {role.tools.join(', ') || 'none'}</div>
        {role.responsibilities.length > 0 && (
          <ul className="proposal-list">
            {role.responsibilities.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        )}
        <div className="proposal-prompt">{role.prompt}</div>
      </div>
    </details>
  )
}

function ChangedRow({ item }: { item: ChangedRole<PayloadRole> }): ReactElement {
  return (
    <div className="org-diff-row is-changed">
      <div className="org-diff-line">
        <Badge tone="warning" icon={Pencil}>
          Changed
        </Badge>
        <RoleAvatar role={item.role} />
        <span className="org-diff-name">{item.role.name}</span>
      </div>
      <ul className="org-diff-fields">
        {item.changes.map((c) => (
          <li key={c.field}>{c.field === 'prompt' ? 'prompt changed' : `${c.label}: ${c.from} -> ${c.to}`}</li>
        ))}
      </ul>
    </div>
  )
}

function OrgChartBody({ payload, currentRoles }: { payload: Extract<Proposal, { kind: 'orgChart' }>['payload']; currentRoles: Role[] }): ReactElement {
  const diff = diffOrgChart(currentRoles, payload.roles)
  return (
    <div className="org-diff">
      <p className="org-diff-summary">{diff.summary}</p>
      <p className="proposal-rationale">{payload.rationale}</p>
      {diff.added.length > 0 && (
        <div className="org-diff-group" role="group" aria-label="Added roles">
          {diff.added.map((r) => (
            <AddedRow key={r.id} role={r} all={payload.roles} />
          ))}
        </div>
      )}
      {diff.changed.length > 0 && (
        <div className="org-diff-group" role="group" aria-label="Changed roles">
          {diff.changed.map((c) => (
            <ChangedRow key={c.role.id} item={c} />
          ))}
        </div>
      )}
      {diff.removed.length > 0 && (
        <div className="org-diff-group" role="group" aria-label="Removed roles">
          {diff.removed.map((r) => (
            <div key={r.id} className="org-diff-row is-removed">
              <div className="org-diff-line">
                <Badge tone="danger" icon={Minus}>
                  Removed
                </Badge>
                <span className="org-diff-name">{r.name}</span>
                <span className="org-diff-meta">was reporting to {parentLabel(r, currentRoles)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {diff.unchanged.length > 0 && (
        <details className="org-diff-unchanged">
          <summary>
            {diff.unchanged.length} unchanged {diff.unchanged.length === 1 ? 'role' : 'roles'}
          </summary>
          <ul className="proposal-list">
            {diff.unchanged.map((r) => (
              <li key={r.id}>{r.name}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function SettingsBody({ payload }: { payload: Extract<Proposal, { kind: 'settings' }>['payload'] }): ReactElement {
  const rows: [string, string][] = []
  if (payload.permissionMode) {
    rows.push(['Permission mode', PERMISSION_MODE_OPTIONS.find((o) => o.value === payload.permissionMode)?.label ?? payload.permissionMode])
  }
  if (payload.maxBudgetUsd !== undefined) rows.push(['Spend cap per run', payload.maxBudgetUsd === null ? 'No cap' : `$${payload.maxBudgetUsd}`])
  if (payload.maxSubagentDepth !== undefined) rows.push(['Max subagent depth', String(payload.maxSubagentDepth)])
  if (payload.maxConcurrentSubagents !== undefined) rows.push(['Max concurrent subagents', String(payload.maxConcurrentSubagents)])
  if (payload.isolateWriters !== undefined) rows.push(['Isolate writers in worktrees', payload.isolateWriters ? 'on' : 'off'])
  if (payload.reviewMerges !== undefined) rows.push(['Review changes before merging', payload.reviewMerges ? 'on' : 'off'])
  if (payload.autoContinue !== undefined) rows.push(['Keep going until the plan is complete', payload.autoContinue ? 'on' : 'off'])
  if (payload.maxAutoContinues !== undefined) rows.push(['Max automatic continues per run', String(payload.maxAutoContinues)])
  return (
    <>
      <p className="proposal-rationale">{payload.rationale}</p>
      {rows.length > 0 && (
        <div className="proposal-kv">
          {rows.map(([k, v]) => (
            <span key={k} className="proposal-kv-row">
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </span>
          ))}
        </div>
      )}
      {payload.allowRules && payload.allowRules.length > 0 && (
        <Section title="Commands that never ask">
          <div className="proposal-rules">
            {payload.allowRules.map((r) => (
              <code key={r}>{r}</code>
            ))}
          </div>
        </Section>
      )}
      {payload.brief && (
        <Section title="Project brief">
          <div className="proposal-prompt">{payload.brief}</div>
        </Section>
      )}
    </>
  )
}

/** Agent text is untrusted: plain text, clamped, never a link or Markdown. */
function ClampText({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const long = text.length > 240 || text.split('\n').length > 4
  return (
    <>
      <p className={`mcp-prop-text${long && !open ? ' clamped' : ''}`}>{text}</p>
      {long && (
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  )
}

function McpServersBody({ payload }: { payload: Extract<Proposal, { kind: 'mcpServers' }>['payload'] }): ReactElement {
  const remove = payload.remove ?? []
  const secrets = payload.secrets ?? []
  return (
    <div className="mcp-prop">
      <ClampText text={payload.rationale} />
      {payload.upsert.map((s) => {
        const target = s.transport === 'stdio' ? [s.command ?? '', ...(s.args ?? [])].join(' ').trim() : (s.url ?? '')
        const slots = secrets.filter((x) => x.serverId === s.id).map((x) => x.name)
        const secretNames = slots.length > 0 ? slots : [...(s.secretEnv ?? []), ...(s.secretHeaders ?? [])]
        return (
          <div key={s.id} className="mcp-prop-server" data-server={s.name}>
            <div className="mcp-prop-head">
              <strong>{s.name}</strong>
              <span className="chip">{s.transport}</span>
              {s.registry && <span className="chip">{`${s.registry.registryType} ${s.registry.identifier}@${s.registry.version}`}</span>}
            </div>
            {s.description && <ClampText text={s.description} />}
            <div className="code-block">{target}</div>
            <div className="mono-dim">roles: {s.roles === undefined ? 'every role' : s.roles.length > 0 ? s.roles.join(', ') : 'none'}</div>
            {s.env && Object.keys(s.env).length > 0 && (
              <div className="mono-dim">
                env:{' '}
                {Object.entries(s.env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')}
              </div>
            )}
            {secretNames.length > 0 && <div className="mono-dim">secrets to set after approving: {secretNames.join(', ')}</div>}
          </div>
        )
      })}
      {remove.length > 0 && (
        <Section title="Remove">
          <div className="proposal-rules">
            {remove.map((id) => (
              <code key={id}>{id}</code>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
