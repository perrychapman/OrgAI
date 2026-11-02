import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { useTeamAssistantStore } from '../../store/teamAssistant'
import { cleanIpcError } from '../../lib/ipcError'
import { oneLine, permissionTitle } from '../../lib/decisionTitle'
import { defaultDecisionIndex } from '../../lib/needsYou'
import DecisionTray, { type DecisionItem } from '../DecisionTray'
import McpInstallCard from '../McpInstallCard'
import MergeReviewCard from '../MergeReviewCard'
import PermissionCard from '../PermissionCard'
import ProposalCard from '../ProposalCard'
import QuestionCard from '../QuestionCard'
import RuleRequestCard from '../RuleRequestCard'

const short = (t: string, n = 40): string => {
  const c = Array.from(oneLine(t, 10_000))
  return c.length > n ? `${c.slice(0, n - 1).join('')}…` : c.join('')
}

/**
 * Every open decision of a Team-tab Architect session (permission, question, rules, merge, MCP install, proposal) on the
 * shared DecisionTray / DecisionCard shell, answered in place: the run is not on the Live strip. A Needs-you jump
 * (`designJump`) selects and focuses the named card.
 */
export default function ArchitectDecisions({ runId, project }: { runId: string; project: Project }): ReactElement | null {
  const run = useAppStore((s) => s.runs[runId])
  const jump = useTeamAssistantStore((s) => s.designJump)
  const clearJump = useTeamAssistantStore((s) => s.clearDesignJump)
  const [picked, setPicked] = useState<string | null>(null)
  const [dismissedInstalls, setDismissedInstalls] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const forMe = !!jump && jump.runId === runId
  useEffect(() => {
    if (!forMe || !jump) return
    if (jump.request) setPicked(jump.request)
    const t = setTimeout(() => {
      const root = rootRef.current
      const target =
        root?.querySelector<HTMLElement>('.decision-footer .btn.primary:not([disabled])') ??
        root?.querySelector<HTMLElement>('button:not([disabled]), textarea, input, select')
      target?.focus()
      target?.scrollIntoView?.({ block: 'nearest' })
      clearJump()
    }, 80)
    return () => clearTimeout(t)
  }, [forMe, jump, clearJump])

  if (!run) return null
  const guard = async (p: Promise<void>): Promise<void> => {
    setError(null)
    try {
      await p
    } catch (e) {
      setError(cleanIpcError(e))
    }
  }
  const who = (agentId: string): string => run.agents[agentId]?.name ?? 'An agent'
  const resolvedInstalls = Object.values(run.mcpResolved ?? {}).filter((r) => !dismissedInstalls[r.request.id])
  const installs = [...(run.mcpInstalls ?? []).map((request) => ({ request, outcome: undefined as undefined | NonNullable<typeof run.mcpResolved>[string]['outcome'] })), ...resolvedInstalls.map((r) => ({ request: r.request, outcome: r.outcome }))]
  const items: DecisionItem[] = [
    ...(run.ruleRequests ?? []).map((r) => ({
      key: r.id,
      label: `Rules: ${short(r.rules.join(', '))}`,
      node: <RuleRequestCard runId={runId} request={r} who={who(r.agentId)} onDecide={(d) => guard(window.orgai.permissions.decideRequest({ runId, requestId: r.id, decision: d }))} />
    })),
    ...(run.questions ?? []).map((q) => ({
      key: q.id,
      label: `Question: ${short(q.question)}`,
      node: <QuestionCard runId={runId} question={q} who="The Architect" onAnswer={(a) => guard(window.orgai.setup.answer({ runId, questionId: q.id, answer: a }))} />
    })),
    ...run.proposals.map((p) => ({
      key: p.id,
      label: short(p.title),
      node: <ProposalCard runId={runId} who="The Architect" proposal={p} currentRoles={project.roles} onDecide={(d) => guard(window.orgai.setup.decide({ runId, proposalId: p.id, decision: d }))} />
    })),
    ...(run.mergeReviews ?? []).map((m) => ({
      key: m.id,
      label: `Merge ${short(m.agentName, 24)}`,
      node: <MergeReviewCard runId={runId} review={m} onDecide={(d) => guard(window.orgai.runs.decideMerge({ runId, reviewId: m.id, decision: d }))} />
    })),
    ...run.permissions.map((p) => ({
      key: p.id,
      label: short(permissionTitle(p.toolName, p.input)),
      node: <PermissionCard runId={runId} request={p} who={who(p.agentId)} onDecide={(d) => guard(window.orgai.runs.decide({ runId, requestId: p.id, decision: d }))} />
    })),
    ...installs.map((it) => ({
      key: it.request.id,
      label: `Install ${short(it.request.spec.name, 28)}`,
      node: (
        <McpInstallCard
          runId={runId}
          request={it.request}
          agentName={who(it.request.agentId)}
          resolved={it.outcome}
          onDismiss={() => setDismissedInstalls((d) => ({ ...d, [it.request.id]: true }))}
        />
      )
    }))
  ]
  const isRecord = (key: string): boolean => resolvedInstalls.some((r) => r.request.id === key)
  items.sort((a, b) => Number(isRecord(b.key)) - Number(isRecord(a.key)))
  if (items.length === 0) return null
  const at = items.findIndex((d) => d.key === picked)
  const selected = at >= 0 ? at : defaultDecisionIndex(items.map((d) => d.key), isRecord)
  const shown = items[selected]?.key ?? null
  return (
    <div className="architect-decisions" ref={rootRef} data-testid="architect-decisions" role="group" aria-label="Decisions for the Architect">
      {error && (
        <p className="capability-warn" role="alert">
          {error}
        </p>
      )}
      <DecisionTray items={items} selected={selected} onSelect={(i) => setPicked(items[i].key)} onPin={() => shown && shown !== picked && setPicked(shown)} />
    </div>
  )
}
