import { agentLabel } from '../render'
import { safeLine } from '../output'
import type { TranscriptRow, TuiState } from './types'

export interface TeamMessageRow {
  key: string
  runId: string
  fromId: string
  toId: string | null
  fromLabel: string
  toLabel: string
  text: string
  at: number
}

/** Live previews survive an in-session resync; a new attachment starts with no invented history. */
export function teamMessageRows(state: TuiState): TeamMessageRow[] {
  const runId = state.activeRunId
  const run = runId ? state.runs[runId] : undefined
  if (!run || !runId) return []
  return (run.messages ?? []).filter(m => m.text !== undefined).map((m, i) => ({
    key: `${runId}:${m.from}:${m.toHandle}:${m.at}:${i}`,
    runId,
    fromId: m.from,
    toId: m.to,
    fromLabel: safeLine(run.agents[m.from] ? agentLabel(run.agents[m.from]) : m.from),
    toLabel: safeLine(m.to && run.agents[m.to] ? agentLabel(run.agents[m.to]) : m.toHandle || 'Unknown recipient'),
    text: safeLine(m.text ?? '').slice(0, 200),
    at: m.at
  }))
}

/** Sparse milestones use recorded agent timestamps, so loading history cannot manufacture new events. */
export function withTeamMilestones(state: TuiState, rows: TranscriptRow[]): TranscriptRow[] {
  const runId = state.activeRunId
  const run = runId ? state.runs[runId] : undefined
  if (!run || !runId) return rows
  const milestones: TranscriptRow[] = []
  for (const agent of Object.values(run.agents)) {
    if (!agent.parentId) continue
    const label = safeLine(agentLabel(agent))
    if (Number.isFinite(agent.startedAt)) milestones.push({
      key: `team:${runId}:${agent.id}:joined`, runId, agentId: agent.id,
      kind: 'system', text: `${label} joined the team`, at: agent.startedAt, tone: 'dim'
    })
    if ((agent.state === 'done' || agent.state === 'error') && Number.isFinite(agent.endedAt)) milestones.push({
      key: `team:${runId}:${agent.id}:ended`, runId, agentId: agent.id,
      kind: 'system', text: `${label} ${agent.state === 'error' ? 'stopped with an error' : 'finished its assignment'}`,
      at: agent.endedAt, tone: agent.state === 'error' ? 'danger' : 'ok'
    })
  }
  if (!milestones.length) return rows
  const before = rows.filter(r => r.runId !== runId || r.kind === 'divider')
  const current = rows.filter(r => r.runId === runId && r.kind !== 'divider')
  return [...before, ...[...current, ...milestones].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))]
}
