import type { RunStatus } from '@shared/types'
import { isOpenStatus, needsYou } from './runChains'

/** Structural view of a run's open decisions, so this stays free of store types. */
export interface WaitRun {
  summary: { id: string; status: RunStatus; startedAt: number }
  agents: Record<string, { name: string }>
  permissions?: readonly { id: string; agentId: string; toolName: string }[]
  proposals?: readonly { id: string }[]
  questions?: readonly { id: string; agentId: string; question: string }[]
  ruleRequests?: readonly { id: string; agentId: string }[]
  mergeReviews?: readonly { id: string; agentName: string }[]
  mcpInstalls?: readonly { id: string; agentId: string }[]
  plan?: { status: string }
}

export type WaitingKind = 'permission' | 'question' | 'rules' | 'proposal' | 'merge' | 'install' | 'plan'

export interface WaitingItem {
  key: string
  runId: string
  kind: WaitingKind
  /** What the run is waiting for, in words. */
  label: string
}

/** Every decision an open run is waiting on, in the order the cards show. */
export function waitingItems(run: WaitRun): WaitingItem[] {
  if (!needsYou(run)) return []
  const runId = run.summary.id
  const who = (agentId: string): string => run.agents[agentId]?.name ?? 'An agent'
  const items: WaitingItem[] = []
  for (const r of run.ruleRequests ?? []) items.push({ key: r.id, runId, kind: 'rules', label: `${who(r.agentId)} asks for permission rules` })
  for (const q of run.questions ?? []) items.push({ key: q.id, runId, kind: 'question', label: `Question: ${q.question}` })
  for (const p of run.proposals ?? []) items.push({ key: p.id, runId, kind: 'proposal', label: 'Proposal to approve' })
  for (const m of run.mergeReviews ?? []) items.push({ key: m.id, runId, kind: 'merge', label: `Review ${m.agentName}'s changes` })
  for (const p of run.permissions ?? []) items.push({ key: p.id, runId, kind: 'permission', label: `${who(p.agentId)} wants to use ${p.toolName}` })
  for (const i of run.mcpInstalls ?? []) items.push({ key: i.id, runId, kind: 'install', label: `${who(i.agentId)} asks to install an MCP server` })
  if (items.length === 0 && run.plan?.status === 'blocked') items.push({ key: `${runId}:plan`, runId, kind: 'plan', label: 'The plan is blocked and needs your decision' })
  return items
}

/**
 * Which run a project opens on: the run that needs you first, else the last viewed one, else the newest open run,
 * else the newest run of all (live or in history). Undefined only for a project with no runs.
 */
export function defaultRunToOpen(
  live: readonly WaitRun[],
  history: readonly { id: string; startedAt: number }[],
  lastViewedId?: string
): string | undefined {
  const byStart = [...live].sort((a, b) => a.summary.startedAt - b.summary.startedAt)
  const waiting = byStart.find((r) => needsYou(r))
  if (waiting) return waiting.summary.id
  if (lastViewedId && (live.some((r) => r.summary.id === lastViewedId) || history.some((h) => h.id === lastViewedId))) return lastViewedId
  const open = [...byStart].reverse().find((r) => isOpenStatus(r.summary.status))
  if (open) return open.summary.id
  const all = [...live.map((r) => ({ id: r.summary.id, startedAt: r.summary.startedAt })), ...history].sort((a, b) => b.startedAt - a.startedAt)
  return all[0]?.id
}
