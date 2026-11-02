import type { ReactElement, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Minus, Pencil, Plus } from 'lucide-react'
import type { Proposal, ProposalDecision, Role } from '@shared/types'
import { PERMISSION_MODE_OPTIONS, PROPOSAL_NOTE_MAX_CHARS, proposalSecretKey } from '@shared/types'
import { initials } from '../lib/layout'
import { useAppStore } from '../store/useAppStore'
import { proposalNextFor } from '../lib/proposalNext'
import { mcpApplyNote, proposalScope, PROPOSAL_EFFECT_COPY, SECRETS_HELP, SKIP_MCP_FEEDBACK, uniqueSecretSlots } from '../lib/mcpProposal'
import { diffOrgChart, modelDisplay, type ChangedRole, type DiffRole } from '../lib/orgDiff'
import { proposalFoldSummary, proposerName, revisePlaceholder } from '../lib/proposalSummary'
import DecisionCard, { useDecisionAnswer } from './DecisionCard'
import { oneLine, proposalTitle } from '../lib/decisionTitle'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Textarea } from './ui/Textarea'
import { McpProposalBody, type SecretValues } from './proposals/McpProposalBody'
import { SkillsProposalBody } from './proposals/SkillsProposalBody'
import { useMcpCurrent } from './proposals/useCurrent'

interface Props {
  proposal: Proposal
  /** The run the proposal belongs to (named above the card header). */
  runId: string
  /** The project's current roles, for the org-chart diff. */
  currentRoles: Role[]
  /** The proposing agent's display name, when known. */
  who?: string
  /** The proposing agent's id, for the avatar's role colour (unset for setup runs). */
  agentId?: string
  onDecide: (decision: ProposalDecision) => void | Promise<void>
}

const APPLY_NOTE: Record<Proposal['kind'], string> = {
  architecture: 'Approving writes .orgai/ARCHITECTURE.md into the working directory and references it from CLAUDE.md.',
  orgChart: 'Approving replaces the project’s org chart with these roles. You can still edit them by hand afterwards.',
  settings: 'Approving updates the project settings and brief, and saves any allowed commands to .claude/settings.local.json.',
  mcpServers: 'Approving saves these MCP servers to the project. Secrets are entered separately and stored encrypted.',
  // The skills card picks its own note by scope (skillsApplyNote).
  skills: 'Approving writes these skills to this project and grants them to the listed roles.'
}

/** Helper line of the skills card: library-only proposals write to the library, any project item writes to the project. */
export function skillsApplyNote(payload: Extract<Proposal, { kind: 'skills' }>['payload']): string {
  return payload.items.every((i) => i.scope === 'library')
    ? 'Approving writes these skills to your library.'
    : 'Approving writes these skills to this project and grants them to the listed roles.'
}

type Mode = 'idle' | 'revise' | 'decline'

export default function ProposalCard({ proposal, runId, currentRoles, who, agentId, onDecide }: Props): ReactElement {
  const [mode, setMode] = useState<Mode>('idle')
  const [feedback, setFeedback] = useState('')
  const [note, setNote] = useState('')
  // Typed secret values by slot index in payload.secrets. They stay in this component's state until Approve.
  const [secretValues, setSecretValues] = useState<SecretValues>({})
  const { busy, error, submit } = useDecisionAnswer()
  const runSummary = useAppStore((st) => st.runs[runId]?.summary)
  const isSetup = runSummary?.kind === 'setup'
  const canSkip = isSetup && proposal.kind === 'mcpServers'
  const canDecline = !isSetup && (proposal.kind === 'mcpServers' || proposal.kind === 'orgChart' || proposal.kind === 'skills')
  const project = useAppStore((st) => st.projects.find((p) => p.id === runSummary?.projectId))
  const mcp = proposal.kind === 'mcpServers' ? proposal.payload : null
  const scope = mcp ? proposalScope(mcp) : 'project'
  // The library is read when the card needs it: library scope (what is there now) and link rows (their command). The
  // project's servers are read through the preload too: the store's copy can be stale.
  const needsLibrary = !!mcp && (scope === 'library' || mcp.upsert.some((s) => s.libraryId))
  const mcpCurrent = useMcpCurrent({ active: !!mcp, scope, projectId: project?.id, needsLibrary, storeServers: project?.mcpServers ?? null })
  const skillCurrent = useMemo(() => ({ roles: currentRoles, skills: project?.skills ?? [] }), [currentRoles, project?.skills])
  const mcpLoading = !!mcp && mcpCurrent.status === 'loading'
  const foldSummary = useMemo(
    () => (mcpLoading ? undefined : proposalFoldSummary(proposal, { roles: currentRoles, mcpServers: mcpCurrent.servers, skills: skillCurrent })),
    [proposal, currentRoles, mcpCurrent.servers, skillCurrent, mcpLoading]
  )
  const helperText =
    proposal.kind === 'mcpServers' ? mcpApplyNote(scope) : proposal.kind === 'skills' ? skillsApplyNote(proposal.payload) : APPLY_NOTE[proposal.kind]
  const hasSecrets = !!mcp && uniqueSecretSlots(mcp).length > 0

  const setSecret = (index: number, v: string): void => setSecretValues((cur) => ({ ...cur, [index]: v }))

  const skip = (): void => {
    void submit(() => onDecide({ behavior: 'revise', feedback: SKIP_MCP_FEEDBACK }))
  }

  const approve = (): void => {
    // Only non-empty values, keyed by the contract's slot key; omitted when none were typed.
    const secrets: Record<string, string> = {}
    if (mcp) for (const { index, slot } of uniqueSecretSlots(mcp)) if (secretValues[index]) secrets[proposalSecretKey(slot)] = secretValues[index]
    const decision: ProposalDecision = Object.keys(secrets).length > 0 ? { behavior: 'approve', secrets } : { behavior: 'approve' }
    void submit(async () => {
      await onDecide(decision)
      // The card disappears once resolved; the run's metadata line keeps the pointer to where the result went.
      const home = useAppStore.getState().runs[runId]?.summary.projectId
      useAppStore.getState().noteProposalNext(runId, home ? proposalNextFor(proposal, home) : null)
    })
  }
  const revise = (): void => {
    if (!feedback.trim()) return
    void submit(() => onDecide({ behavior: 'revise', feedback: feedback.trim() }))
  }
  const decline = (): void => {
    void submit(() => onDecide({ behavior: 'decline', note: note.trim() || undefined }))
  }

  return (
    <DecisionCard
      kind="proposal"
      error={error}
      runId={runId}
      who={who}
      agentId={agentId}
      focusDetails
      title={proposalTitle(proposal.kind)}
      summary={foldSummary}
      helper={
        <>
          {helperText}
          {hasSecrets && <span className="proposal-effect">{SECRETS_HELP}</span>}
          {proposal.effect && (
            <span className="proposal-effect" data-testid="proposal-effect">
              {PROPOSAL_EFFECT_COPY[proposal.effect]}
            </span>
          )}
        </>
      }
      primary={
        mode === 'idle' ? (
          <Button variant="primary" onClick={approve} disabled={busy}>
            Approve
          </Button>
        ) : mode === 'revise' ? (
          <Button variant="primary" onClick={revise} disabled={busy || !feedback.trim()}>
            Send feedback
          </Button>
        ) : (
          <Button variant="primary" onClick={decline} disabled={busy} testId="proposal-decline-send">
            Decline
          </Button>
        )
      }
      secondary={
        mode === 'idle' ? (
          <>
            <Button onClick={() => setMode('revise')} disabled={busy}>
              Request changes
            </Button>
            {canDecline && (
              <Button variant="ghost" onClick={() => setMode('decline')} disabled={busy} testId="proposal-decline">
                Not now
              </Button>
            )}
            {canSkip && (
              <Button onClick={skip} disabled={busy} testId="mcp-proposal-skip">
                Skip
              </Button>
            )}
          </>
        ) : (
          <Button variant="ghost" onClick={() => setMode('idle')} disabled={busy}>
            Back
          </Button>
        )
      }
    >
      {proposal.title.trim() && <p className="proposal-lead">{oneLine(proposal.title, 200)}</p>}
      {proposal.kind === 'architecture' && <ArchitectureBody payload={proposal.payload} />}
      {proposal.kind === 'orgChart' && <OrgChartBody payload={proposal.payload} currentRoles={currentRoles} />}
      {proposal.kind === 'settings' && <SettingsBody payload={proposal.payload} />}
      {proposal.kind === 'mcpServers' && <McpProposalBody payload={proposal.payload} current={mcpCurrent} roles={currentRoles} secretValues={secretValues} setSecret={setSecret} />}
      {proposal.kind === 'skills' && <SkillsProposalBody payload={proposal.payload} current={skillCurrent} projectId={project?.id} />}
      {mode === 'revise' && (
        <div className="proposal-feedback">
          <Textarea
            autoFocus
            aria-label="What should change?"
            value={feedback}
            onChange={setFeedback}
            placeholder={revisePlaceholder(proposerName(runSummary))}
          />
        </div>
      )}
      {mode === 'decline' && (
        <div className="proposal-feedback">
          <Textarea
            autoFocus
            aria-label="Anything the agent should know? (optional)"
            data-testid="proposal-decline-note"
            maxLength={PROPOSAL_NOTE_MAX_CHARS}
            value={note}
            onChange={setNote}
            placeholder="Anything the agent should know? (optional)"
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
          reports to {parentLabel(role, all)} · {modelDisplay(role.model)}
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
          {item.renamed ? 'Renamed' : 'Changed'}
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
