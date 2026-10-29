import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Proposal, ProposalDecision } from '@shared/types'
import { PERMISSION_MODE_OPTIONS } from '@shared/types'
import { initials } from '../lib/layout'

interface Props {
  proposal: Proposal
  onDecide: (decision: ProposalDecision) => void
}

const KIND_LABEL: Record<Proposal['kind'], string> = {
  architecture: 'Architecture',
  orgChart: 'Org chart',
  settings: 'Run settings'
}

const APPLY_NOTE: Record<Proposal['kind'], string> = {
  architecture: 'Approving writes .orgai/ARCHITECTURE.md into the working directory and references it from CLAUDE.md.',
  orgChart: 'Approving replaces the project’s org chart with these roles. You can still edit them by hand afterwards.',
  settings: 'Approving updates the project settings and brief, and saves any allowed commands to .claude/settings.local.json.'
}

export default function ProposalCard({ proposal, onDecide }: Props): ReactElement {
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

  return (
    <div className={`proposal kind-${proposal.kind}`}>
      <div className="proposal-head">
        <span className="chip">{KIND_LABEL[proposal.kind]}</span>
        <strong>{proposal.title}</strong>
      </div>
      <div className="proposal-body">
        {proposal.kind === 'architecture' && <ArchitectureBody payload={proposal.payload} />}
        {proposal.kind === 'orgChart' && <OrgChartBody payload={proposal.payload} />}
        {proposal.kind === 'settings' && <SettingsBody payload={proposal.payload} />}
      </div>
      <div className="proposal-note">{APPLY_NOTE[proposal.kind]}</div>
      {revising && (
        <textarea
          className="textarea"
          autoFocus
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="What should change? The Architect revises and proposes again."
          style={{ marginTop: 8 }}
        />
      )}
      <div className="row" style={{ marginTop: 10 }}>
        {!revising ? (
          <>
            <button className="btn primary" onClick={approve} disabled={busy}>
              Approve
            </button>
            <button className="btn" onClick={() => setRevising(true)} disabled={busy}>
              Request changes
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={revise} disabled={busy || !feedback.trim()}>
              Send feedback
            </button>
            <button className="btn ghost" onClick={() => setRevising(false)} disabled={busy}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="proposal-section">
      <div className="side-section-title" style={{ margin: '10px 0 4px' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function ArchitectureBody({ payload }: { payload: Extract<Proposal, { kind: 'architecture' }>['payload'] }): ReactElement {
  return (
    <>
      <p style={{ margin: 0 }}>{payload.summary}</p>
      {payload.stack.length > 0 && (
        <Section title="Stack">
          <div className="row wrap" style={{ gap: 5 }}>
            {payload.stack.map((s, i) => (
              <span key={i} className="chip" style={{ textTransform: 'none', letterSpacing: 0 }}>
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

function OrgChartBody({ payload }: { payload: Extract<Proposal, { kind: 'orgChart' }>['payload'] }): ReactElement {
  const byId = new Map(payload.roles.map((r) => [r.id, r]))
  return (
    <>
      <p style={{ margin: 0, color: 'var(--text-dim)' }}>{payload.rationale}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {payload.roles.map((r) => (
          <details key={r.id} className="proposal-role">
            <summary>
              <span className="avatar" style={{ ['--role' as string]: r.color, width: 22, height: 22, fontSize: 9 }}>
                {initials(r.name)}
              </span>
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              <span className="chip">{r.model}</span>
              {r.canSpawn && <span className="chip">leads {r.spawnable.length}</span>}
              <span style={{ color: 'var(--text-faint)', marginLeft: 'auto', fontSize: 11 }}>
                {r.reportsTo ? `→ ${byId.get(r.reportsTo)?.name ?? ''}` : 'root'}
              </span>
            </summary>
            <div className="proposal-role-body">
              <div>{r.description}</div>
              <div className="mono-dim">tools: {r.tools.join(', ') || 'none'}</div>
              {r.responsibilities.length > 0 && (
                <ul className="proposal-list">
                  {r.responsibilities.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              )}
              <div className="proposal-prompt">{r.prompt}</div>
            </div>
          </details>
        ))}
      </div>
    </>
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
  return (
    <>
      <p style={{ margin: 0, color: 'var(--text-dim)' }}>{payload.rationale}</p>
      {rows.length > 0 && (
        <div className="agent-summary" style={{ padding: '10px 0 0', border: 0 }}>
          {rows.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
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
