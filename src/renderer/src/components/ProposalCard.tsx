import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Minus, Pencil, Plus, TriangleAlert } from 'lucide-react'
import type { Project, Proposal, ProposalDecision, ProjectKind, Role } from '@shared/types'
import { folderName } from '../lib/paths'
import { connectionLabel } from '../lib/connectionLabel'
import { projectSettingRows, type ProjectSettingRow } from '../lib/appSettingsCard'
import { AppSettingsProposalBody } from './proposals/AppSettingsProposalBody'
import { ProjectSettingsChanges } from './proposals/ProjectSettingsChanges'
import { PERMISSION_MODE_OPTIONS, PROPOSAL_NOTE_MAX_CHARS, proposalSecretKey } from '@shared/types'
import { initials } from '../lib/layout'
import { useAppStore } from '../store/useAppStore'
import { proposalNextFor } from '../lib/proposalNext'
import { mcpApplyNote, proposalScope, proposalEffectCopy, secretsHelp, SKIP_MCP_FEEDBACK, uniqueSecretSlots } from '../lib/mcpProposal'
import { diffOrgChart, modelDisplay, type ChangedRole, type DiffRole } from '../lib/orgDiff'
import { proposalFoldSummary, proposerName, revisePlaceholder } from '../lib/proposalSummary'
import DecisionCard, { useDecisionAnswer } from './DecisionCard'
import { oneLine, proposalTitle } from '../lib/decisionTitle'
import { hasHidden, showHidden } from '../lib/hiddenChars'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Textarea } from './ui/Textarea'
import { McpProposalBody, type SecretValues } from './proposals/McpProposalBody'
import { SkillsProposalBody } from './proposals/SkillsProposalBody'
import { useMcpCurrent } from './proposals/useCurrent'
import { ClampText } from './proposals/ClampText'
import { clampLabel } from '../lib/clampLabel'
import { projectConnection, projectKindOf, projectRulesLocation } from '@shared/defaults'
import { projectKindCopy, settingsApplyNoteFor, type ArchitectureHeadings } from '../lib/projectKindCopy'

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
  settings: 'Approving updates the project settings and brief, and saves any allowed commands for this project.',
  mcpServers: 'Approving saves these MCP servers to the project. Secrets are stored encrypted.',
  // The skills card picks its own note by scope (skillsApplyNote).
  skills: 'Approving writes these skills to this project and grants them to the listed roles.',
  appSettings: 'Approving changes these app settings for every project.',
  // PLACEHOLDER (Schedules contract landing): the renderer engineer replaces this with the schedules card body and note.
  schedules: 'Schedule proposals are not available yet.'
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
  const noteId = useId()
  const [expandSignal, setExpandSignal] = useState(0)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const prevMode = useRef<Mode>('idle')
  const feedbackRef = useRef<HTMLDivElement>(null)
  // Entering a mode opens the folded body and focuses its field; Back returns focus to the button that opened it.
  useEffect(() => {
    const from = prevMode.current
    prevMode.current = mode
    if (mode !== 'idle') {
      setExpandSignal((n) => n + 1)
      // The folded body opens on the next render; focus the field after it.
      const id = requestAnimationFrame(() => feedbackRef.current?.querySelector('textarea')?.focus())
      return () => cancelAnimationFrame(id)
    } else if (from !== 'idle') {
      anchorRef.current?.closest('article')?.querySelector<HTMLElement>(`[data-testid="proposal-${from}"]`)?.focus()
    }
    return undefined
  }, [mode])
  const [secretValues, setSecretValues] = useState<SecretValues>({})
  const { busy, error, submit } = useDecisionAnswer()
  const runSummary = useAppStore((st) => st.runs[runId]?.summary)
  const isSetup = runSummary?.kind === 'setup'
  const canSkip = isSetup && proposal.kind === 'mcpServers'
  const target = proposal.kind === 'settings' || proposal.kind === 'appSettings' ? proposal.target : undefined
  const selfHelp = proposal.kind === 'appSettings' || (proposal.kind === 'settings' && !!target)
  const canDecline = !isSetup && (proposal.kind === 'mcpServers' || proposal.kind === 'orgChart' || proposal.kind === 'skills' || selfHelp)
  const project = useAppStore((st) => st.projects.find((p) => p.id === runSummary?.projectId))
  // A Chat proposal for another project is worded for that project's kind, never the virtual project's.
  const targetProject = useAppStore((st) => (target ? st.projects.find((p) => p.id === target.projectId) : undefined))
  const kind = projectKindOf(target ? targetProject : project)
  const targetName = target ? clampLabel(showHidden(target.projectName), 40) || 'this project' : ''
  const targetKind = target ? kind : undefined
  const settingRows = useMemo(() => (proposal.kind === 'settings' && target ? projectSettingRows(proposal.payload, kind, targetProject) : []), [proposal, target, kind, targetProject])
  const kindCopy = projectKindCopy(kind)
  const mcp = proposal.kind === 'mcpServers' ? proposal.payload : null
  const scope = mcp ? proposalScope(mcp) : 'project'
  // The library is read when the card needs it: library scope (what is there now) and link rows (their command). The
  // project's servers are read through the preload too: the store's copy can be stale.
  const needsLibrary = !!mcp && (scope === 'library' || mcp.upsert.some((s) => s.libraryId))
  const mcpCurrent = useMcpCurrent({ active: !!mcp, scope, projectId: project?.id, needsLibrary, storeServers: project?.mcpServers ?? null })
  const skillCurrent = useMemo(() => ({ roles: currentRoles, skills: project?.skills ?? [] }), [currentRoles, project?.skills])
  const mcpLoading = !!mcp && mcpCurrent.status === 'loading'
  const foldSummary = useMemo(
    () => (mcpLoading ? undefined : proposalFoldSummary(proposal, { roles: currentRoles, mcpServers: mcpCurrent.servers, skills: skillCurrent, projectKind: targetKind })),
    [proposal, currentRoles, mcpCurrent.servers, skillCurrent, mcpLoading, targetKind]
  )
  const hasSecrets = !!mcp && uniqueSecretSlots(mcp).length > 0
  const effectCopy = proposalEffectCopy(proposal.effect, isSetup ? 'architect' : runSummary?.kind === 'mcp-assist' || runSummary?.kind === 'skill-assist' || runSummary?.quick ? 'assistant' : 'orchestrator')
  const helperText =
    proposal.kind === 'mcpServers'
      ? mcpApplyNote(scope, hasSecrets)
      : proposal.kind === 'skills'
        ? skillsApplyNote(proposal.payload)
        : proposal.kind === 'architecture'
          ? kindCopy.architectureApplyNote
          : proposal.kind === 'appSettings'
            ? 'Applies now to every project and window.'
            : proposal.kind === 'settings'
              ? target
                ? targetSettingsNote(proposal.payload, kind, targetProject)
                : settingsApplyNoteFor(kind, projectRulesLocation(project))
              : APPLY_NOTE[proposal.kind]

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
      expandSignal={expandSignal}
      focusDetails
      title={proposal.kind === 'architecture' ? kindCopy.architectureTitle : target && proposal.kind === 'settings' ? oneLine(`Change settings of ${targetName}`) : proposal.kind === 'appSettings' ? 'Change app settings' : proposalTitle(proposal.kind)}
      target={
        proposal.kind === 'appSettings' ? (
          <Badge tone="info" testId="proposal-target-badge">
            App settings
          </Badge>
        ) : target ? (
          <Badge tone="info" testId="proposal-target-badge" title={showHidden(target.projectName)}>
            {targetName}
          </Badge>
        ) : undefined
      }
      summary={foldSummary}
      helper={
        <>
          {helperText}
          {hasSecrets && <span className="proposal-effect">{secretsHelp(scope)}</span>}
          {effectCopy && (
            <span className="proposal-effect" data-testid="proposal-effect">
              {effectCopy}
            </span>
          )}
        </>
      }
      primary={
        mode === 'idle' ? (
          <Button variant="primary" onClick={approve} disabled={busy || mcpLoading} testId="proposal-approve">
            {proposal.kind === 'appSettings' ? 'Apply to App settings' : target && proposal.kind === 'settings' ? `Apply to ${clampLabel(targetName, 40)}` : 'Approve'}
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
            {/* Self-help cards put Decline beside Apply, before Request changes (UX M4). */}
            {canDecline && selfHelp && (
              <Button onClick={() => setMode('decline')} disabled={busy} testId="proposal-decline">
                Decline
              </Button>
            )}
            <Button onClick={() => setMode('revise')} disabled={busy} testId="proposal-revise">
              Request changes
            </Button>
            {canDecline && !selfHelp && (
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
      {proposal.kind === 'architecture' && <ArchitectureBody payload={proposal.payload} headings={kindCopy.architecture} />}
      {proposal.kind === 'orgChart' && <OrgChartBody payload={proposal.payload} currentRoles={currentRoles} />}
      {proposal.kind === 'settings' && target && (
        <p className="proposal-target" data-testid="proposal-target">
          {targetLine(target.projectName, targetProject)}
        </p>
      )}
      {proposal.kind === 'settings' && <SettingsBody payload={proposal.payload} kind={kind} rows={target ? settingRows : undefined} />}
      {proposal.kind === 'appSettings' && <AppSettingsProposalBody payload={proposal.payload} />}
      {proposal.kind === 'mcpServers' && <McpProposalBody proposalId={proposal.id} payload={proposal.payload} current={mcpCurrent} roles={currentRoles} secretValues={secretValues} setSecret={setSecret} />}
      {proposal.kind === 'skills' && <SkillsProposalBody proposalId={proposal.id} payload={proposal.payload} current={skillCurrent} projectId={project?.id} />}
      {mode !== 'idle' && (
        <div className="proposal-feedback" ref={feedbackRef}>
          <label className="proposal-note-label" htmlFor={`${noteId}-${mode}`}>
            {mode === 'revise' ? 'What should change?' : 'Anything the agent should know? (optional)'}
          </label>
          {mode === 'revise' ? (
            <Textarea
              id={`${noteId}-revise`}
              value={feedback}
              onChange={setFeedback}
              maxLength={PROPOSAL_NOTE_MAX_CHARS}
              placeholder={revisePlaceholder(proposerName(runSummary))}
            />
          ) : (
            <Textarea id={`${noteId}-decline`} data-testid="proposal-decline-note" maxLength={PROPOSAL_NOTE_MAX_CHARS} value={note} onChange={setNote} />
          )}
          <span className="proposal-note-hint">Up to {PROPOSAL_NOTE_MAX_CHARS.toLocaleString('en-US')} characters</span>
        </div>
      )}
      <span ref={anchorRef} hidden />
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

function ArchitectureBody({ payload, headings }: { payload: Extract<Proposal, { kind: 'architecture' }>['payload']; headings: ArchitectureHeadings }): ReactElement {
  return (
    <>
      {headings.summary === 'Summary' ? (
        <p className="proposal-lead">{payload.summary}</p>
      ) : (
        <Section title={headings.summary}>
          <p className="proposal-lead">{payload.summary}</p>
        </Section>
      )}
      {payload.stack.length > 0 && (
        <Section title={headings.stack}>
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
        <Section title={headings.modules}>
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
        <Section title={headings.conventions}>
          <ul className="proposal-list">
            {payload.conventions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </Section>
      )}
      {payload.commands.length > 0 && (
        <Section title={headings.commands}>
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
        <Section title={headings.risks}>
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

/**
 * A role's prompt behind a disclosure (review M3): untrusted agent text, shown through ClampText (showHidden, clamped,
 * never Markdown), with the hidden-characters badge when it holds any.
 */
function PromptDisclosure({ prompt, roleName, label }: { prompt: string; roleName: string; label: string }): ReactElement {
  const name = clampLabel(showHidden(roleName), 60)
  return (
    <details className="org-diff-prompt" data-testid="org-diff-prompt">
      <summary>
        {label}
        <span className="sr-only"> for {name}</span>
      </summary>
      <div className="org-diff-prompt-body">
        {hasHidden(prompt) && (
          <Badge tone="danger" icon={TriangleAlert} testId="org-diff-prompt-hidden">
            Contains hidden characters
          </Badge>
        )}
        {prompt ? <ClampText text={prompt} label={`${name} prompt`} /> : <p className="org-diff-prompt-empty">Empty prompt.</p>}
      </div>
    </details>
  )
}

/** A changed role's new responsibilities behind a disclosure (review M-a): they go into its system prompt, so they are shown like the prompt. */
function ResponsibilitiesDisclosure({ before, items, roleName }: { before: readonly string[]; items: readonly string[]; roleName: string }): ReactElement {
  const name = clampLabel(showHidden(roleName), 60)
  // A dropped line (a constraint) matters as much as a new one; a reorder alone would otherwise look like no change.
  const removed = before.filter((x) => !items.includes(x))
  const added = new Set(items.filter((x) => !before.includes(x)))
  const reorderOnly = removed.length === 0 && added.size === 0
  return (
    <details className="org-diff-prompt" data-testid="org-diff-responsibilities">
      <summary>
        Show new responsibilities
        <span className="sr-only"> for {name}</span>
      </summary>
      <div className="org-diff-prompt-body">
        {items.some(hasHidden) && (
          <Badge tone="danger" icon={TriangleAlert} testId="org-diff-responsibilities-hidden">
            Contains hidden characters
          </Badge>
        )}
        {items.length > 0 ? (
          <ul className="proposal-list org-diff-resp">
            {items.map((x, i) => (
              <li key={i}>
                {added.has(x) && <span className="org-diff-resp-tag">New: </span>}
                {showHidden(x)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="org-diff-prompt-empty">No responsibilities.</p>
        )}
        {reorderOnly && <p className="org-diff-prompt-empty">Same responsibilities in a new order.</p>}
        {removed.length > 0 && (
          <>
            <p className="org-diff-resp-head">Removed</p>
            <ul className="proposal-list org-diff-resp is-removed" data-testid="org-diff-responsibilities-removed">
              {removed.map((x, i) => (
                <li key={i}>{showHidden(x)}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  )
}

function AddedRow({ role, all }: { role: PayloadRole; all: PayloadRole[] }): ReactElement {
  const hidden = hasHidden(role.name) || hasHidden(role.description) || hasHidden(role.prompt) || role.tools.some(hasHidden) || role.responsibilities.some(hasHidden)
  return (
    <details className="org-diff-row is-added" data-testid="org-diff-row" data-change="added" data-role={clampLabel(role.name, 64)}>
      <summary>
        <Badge tone="success" icon={Plus}>
          Added
        </Badge>
        <RoleAvatar role={role} />
        <span className="org-diff-name">{showHidden(role.name)}</span>
        <span className="org-diff-meta">
          reports to {showHidden(parentLabel(role, all))} · {showHidden(modelDisplay(role.model))}
          {role.canSpawn ? ` · leads ${role.spawnable.length}` : ''}
        </span>
      </summary>
      <div className="proposal-role-body">
        <div>{showHidden(role.description)}</div>
        <div className="mono-dim">tools: {showHidden(role.tools.join(', ')) || 'none'}</div>
        {role.responsibilities.length > 0 && (
          <ul className="proposal-list">
            {role.responsibilities.map((x, i) => (
              <li key={i}>{showHidden(x)}</li>
            ))}
          </ul>
        )}
        {hidden && (
          <Badge tone="danger" icon={TriangleAlert}>
            Contains hidden characters
          </Badge>
        )}
        <PromptDisclosure prompt={role.prompt} roleName={role.name} label="Show prompt" />
      </div>
    </details>
  )
}

/** Fields whose change line is a fixed summary ("prompt changed"); the new text sits behind a disclosure. */
const SUMMARY_FIELDS: ReadonlySet<string> = new Set(['prompt', 'responsibilities'])

function ChangedRow({ item }: { item: ChangedRole<PayloadRole> }): ReactElement {
  // The row badge shows without opening anything, so it also covers the new prompt.
  const hidden =
    hasHidden(item.role.name) ||
    hasHidden(item.prompt?.after) ||
    !!item.responsibilities?.after.some(hasHidden) ||
    item.changes.some((c) => !SUMMARY_FIELDS.has(c.field) && (hasHidden(c.from) || hasHidden(c.to)))
  return (
    <div className="org-diff-row is-changed" data-testid="org-diff-row" data-change="changed" data-role={clampLabel(item.role.name, 64)}>
      <div className="org-diff-line">
        <Badge tone="warning" icon={Pencil}>
          {item.renamed ? 'Renamed' : 'Changed'}
        </Badge>
        <RoleAvatar role={item.role} />
        <span className="org-diff-name">{showHidden(item.role.name)}</span>
        {hidden && (
          <Badge tone="danger" icon={TriangleAlert} testId="org-diff-hidden">
            Contains hidden characters
          </Badge>
        )}
      </div>
      <ul className="org-diff-fields">
        {item.changes.map((c) => (
          <li key={c.field}>{SUMMARY_FIELDS.has(c.field) ? c.to : `${c.label}: ${showHidden(c.from)} -> ${showHidden(c.to)}`}</li>
        ))}
      </ul>
      {item.responsibilities && <ResponsibilitiesDisclosure before={item.responsibilities.before} items={item.responsibilities.after} roleName={item.role.name} />}
      {item.prompt && <PromptDisclosure prompt={item.prompt.after} roleName={item.role.name} label="Show new prompt" />}
    </div>
  )
}

function OrgChartBody({ payload, currentRoles }: { payload: Extract<Proposal, { kind: 'orgChart' }>['payload']; currentRoles: Role[] }): ReactElement {
  const diff = diffOrgChart(currentRoles, payload.roles)
  return (
    <div className="org-diff">
      <p className="org-diff-summary">{diff.summary}</p>
      <p className="proposal-rationale">{showHidden(payload.rationale)}</p>
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
                <span className="org-diff-name">{showHidden(r.name)}</span>
                <span className="org-diff-meta">was reporting to {showHidden(parentLabel(r, currentRoles))}</span>
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
              <li key={r.id}>{showHidden(r.name)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** "Notes API · notes-api · Anthropic": name, folder and connection of a Chat proposal's target; only the name when the project is not loaded. */
function targetLine(name: string, project: Project | undefined): string {
  const parts = [clampLabel(showHidden(name), 60)]
  if (project) {
    const folder = folderName(project.path)
    if (folder) parts.push(clampLabel(showHidden(folder), 60))
    parts.push(connectionLabel(projectConnection(project)))
  }
  return `Applies to ${parts.join(' · ')}`
}

/** Helper line of a target settings card: names the footnote about saved commands only when the proposal carries rules. */
function targetSettingsNote(payload: Extract<Proposal, { kind: 'settings' }>['payload'], kind: ProjectKind, project: Project | undefined): string {
  if (payload.allowRules && payload.allowRules.length > 0) return settingsApplyNoteFor(kind, projectRulesLocation(project))
  return payload.brief ? 'Approving updates the settings and brief of this project.' : 'Approving updates the settings of this project.'
}

function SettingsBody({ payload, kind, rows: tableRows }: { payload: Extract<Proposal, { kind: 'settings' }>['payload']; kind: ProjectKind; rows?: ProjectSettingRow[] }): ReactElement {
  const rows: [string, string][] = []
  const engagement = kind === 'engagement'
  if (engagement && payload.client !== undefined) rows.push(['Client or case', payload.client.trim() ? showHidden(oneLine(payload.client, 120)) : 'Cleared'])
  if (payload.permissionMode) {
    rows.push(['Permission mode', PERMISSION_MODE_OPTIONS.find((o) => o.value === payload.permissionMode)?.label ?? payload.permissionMode])
  }
  if (payload.maxBudgetUsd !== undefined) rows.push(['Spend cap per run', payload.maxBudgetUsd === null ? 'No cap' : `$${payload.maxBudgetUsd}`])
  if (payload.maxSubagentDepth !== undefined) rows.push(['Max subagent depth', String(payload.maxSubagentDepth)])
  if (payload.maxConcurrentSubagents !== undefined) rows.push(['Max concurrent subagents', String(payload.maxConcurrentSubagents)])
  if (payload.isolateWriters !== undefined) rows.push([engagement ? 'Give each writer its own copy (git worktrees)' : 'Isolate writers in worktrees', payload.isolateWriters ? 'on' : 'off'])
  if (payload.reviewMerges !== undefined) rows.push(['Review changes before merging',payload.reviewMerges ? 'on' : 'off'])
  if (payload.autoContinue !== undefined) rows.push(['Keep going until the plan is complete', payload.autoContinue ? 'on' : 'off'])
  if (payload.maxAutoContinues !== undefined) rows.push(['Max automatic continues per run', String(payload.maxAutoContinues)])
  return (
    <>
      <p className="proposal-rationale">{showHidden(payload.rationale)}</p>
      {tableRows ? (
        <ProjectSettingsChanges rows={tableRows} />
      ) : (
        rows.length > 0 && (
        <div className="proposal-kv">
          {rows.map(([k, v]) => (
            <span key={k} className="proposal-kv-row">
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </span>
          ))}
        </div>
        )
      )}
      {payload.allowRules && payload.allowRules.length > 0 && (
        <Section title="Commands that never ask">
          <div className="proposal-rules">
            {payload.allowRules.map((r) => (
              <span key={r} className="proposal-rule">
                <code>{showHidden(r)}</code>
                {hasHidden(r) && (
                  <Badge tone="danger" icon={TriangleAlert}>
                    Contains hidden characters
                  </Badge>
                )}
              </span>
            ))}
          </div>
        </Section>
      )}
      {payload.brief && (
        <Section title="Project brief">
          {hasHidden(payload.brief) && (
            <Badge tone="danger" icon={TriangleAlert}>
              Contains hidden characters
            </Badge>
          )}
          <div className="proposal-prompt">{showHidden(payload.brief)}</div>
        </Section>
      )}
    </>
  )
}
