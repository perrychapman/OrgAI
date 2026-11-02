import { createHash } from 'node:crypto'
import type { Project, RunRecord, TeamEvidence, TeamEvidenceKind } from '@shared/types'
import { correctionFindings, toolSequenceFindings, MAX_TRANSCRIPT_ENTRIES, type EvalRun } from '../skills/evaluate'
import { redactEvidence } from '../skills/suggest'
import { clampText } from './sanitize'

/**
 * Token-free signals from finished work runs for the Team review: permission denials, permission rule requests,
 * tools a role asked for that it lacks, connections it asked for, repeated tool sequences and repeated corrections.
 * Summaries are redacted (keys, tokens, long ids) and clamped; they are untrusted text. Pure; never throws.
 */

/** Work runs looked at, newest first. */
export const EVIDENCE_MAX_RUNS = 20
export const EVIDENCE_MAX_ITEMS = 20
const SUMMARY_MAX = 300

const DENIED = /\b(permission (?:was |is )?denied|not permitted|not allowed|denied by|requires approval|user (?:denied|rejected))\b/i
const MISSING_TOOL = /\b(no such tool|unknown tool|tool (?:is )?not (?:available|found|allowed)|not in (?:the )?allowed tools)\b/i

/** Home directories name the user: C:\Users\x, /Users/x and /home/x become ~. */
function hideHome(text: string): string {
  return text.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"')]+/gi, '~').replace(/\/(?:Users|home)\/[^/\s"')]+/g, '~')
}

function summary(text: string): string {
  return clampText(hideHome(redactEvidence(text)), SUMMARY_MAX)
}

function evidenceId(kind: TeamEvidenceKind, roleId: string | undefined, key: string): string {
  return `ev-${createHash('sha256').update(`${kind}\0${roleId ?? ''}\0${key}`).digest('hex').slice(0, 16)}`
}

interface Acc {
  kind: TeamEvidenceKind
  roleId?: string
  key: string
  summary: string
  runIds: string[]
  count: number
  lastSeenAt: number
}

function toolBase(name: string): string {
  return name.replace(/^mcp__orgai__/, '')
}

export function collectEvidence(project: Project, records: RunRecord[]): TeamEvidence[] {
  try {
    const runs = records
      .filter((r) => r && r.summary && r.summary.kind === 'work' && Array.isArray(r.transcript))
      .sort((a, b) => (b.summary.endedAt ?? b.summary.startedAt) - (a.summary.endedAt ?? a.summary.startedAt))
      .slice(0, EVIDENCE_MAX_RUNS)
    const roleName = (id: string | undefined): string => project.roles.find((r) => r.id === id)?.name ?? 'An agent'
    const acc = new Map<string, Acc>()
    const add = (kind: TeamEvidenceKind, roleId: string | undefined, key: string, text: string, runId: string, at: number): void => {
      const id = evidenceId(kind, roleId, key)
      const e = acc.get(id)
      if (e) {
        e.count++
        if (!e.runIds.includes(runId)) e.runIds.push(runId)
        e.lastSeenAt = Math.max(e.lastSeenAt, at)
      } else acc.set(id, { kind, roleId, key, summary: summary(text), runIds: [runId], count: 1, lastSeenAt: at })
    }
    for (const run of runs) {
      const runId = run.summary.id
      const agentRole = (agentId: string): string | undefined => {
        const r = run.agents?.[agentId]?.roleId
        return typeof r === 'string' && project.roles.some((x) => x.id === r) ? r : undefined
      }
      const toolOwner = new Map<string, { name: string; agentId: string }>()
      const t = run.transcript
      for (let i = 0; i < t.length && i < MAX_TRANSCRIPT_ENTRIES; i++) {
        const e = t[i]!
        const b = e.block
        if (b.kind === 'tool_use') {
          const name = String(b.name ?? '')
          toolOwner.set(b.id, { name, agentId: e.agentId })
          const base = toolBase(name)
          const roleId = agentRole(e.agentId)
          if (base === 'request_permission_rules') {
            const rules = (b.input as { rules?: unknown })?.rules
            const list = Array.isArray(rules) ? rules.filter((x): x is string => typeof x === 'string').slice(0, 4) : []
            const key = list.join(',') || 'rules'
            add('ruleRequest', roleId, key, `${roleName(roleId)} asked for permission rules${list.length ? `: ${list.join(', ')}` : ''}.`, runId, e.at)
          } else if (base === 'request_mcp_install' || base === 'search_mcp_registry') {
            const input = b.input as { query?: unknown; reason?: unknown; name?: unknown } | undefined
            const what = typeof input?.query === 'string' ? input.query : typeof input?.name === 'string' ? input.name : ''
            add('missingConnection', roleId, `${base}:${what.toLowerCase().slice(0, 60)}`, `${roleName(roleId)} looked for a connection${what ? ` (${what})` : ''}.`, runId, e.at)
          }
        } else if (b.kind === 'tool_result' && b.isError) {
          const owner = toolOwner.get(b.toolUseId)
          const roleId = owner ? agentRole(owner.agentId) : agentRole(e.agentId)
          const content = String(b.content ?? '').slice(0, 2000)
          const tool = owner ? toolBase(owner.name) : 'a tool'
          if (MISSING_TOOL.test(content)) add('missingTool', roleId, tool, `${roleName(roleId)} tried ${tool}, which it does not have.`, runId, e.at)
          else if (DENIED.test(content)) add('permissionDenied', roleId, tool, `${roleName(roleId)} was denied ${tool}.`, runId, e.at)
        }
      }
    }
    const evalRuns: EvalRun[] = runs.map((r) => ({ summary: r.summary, transcript: r.transcript }))
    const newest = (ids: string[]): number => Math.max(0, ...runs.filter((r) => ids.includes(r.summary.id)).map((r) => r.summary.endedAt ?? r.summary.startedAt))
    for (const f of toolSequenceFindings(evalRuns)) {
      const ids = f.evidence?.runIds ?? []
      const key = (f.evidence?.sequence ?? []).join('>')
      acc.set(evidenceId('repeatedSequence', undefined, key), { kind: 'repeatedSequence', key, summary: summary(`${f.title}. ${f.detail}`), runIds: [...ids], count: ids.length, lastSeenAt: newest(ids) })
    }
    for (const f of correctionFindings(evalRuns)) {
      const ids = f.evidence?.runIds ?? []
      const key = f.detail.toLowerCase().slice(0, 120)
      acc.set(evidenceId('repeatedCorrection', undefined, key), { kind: 'repeatedCorrection', key, summary: summary(f.detail), runIds: [...ids], count: f.evidence?.count ?? ids.length, lastSeenAt: newest(ids) })
    }
    const order = new Map(runs.map((r, i) => [r.summary.id, i]))
    return [...acc.entries()]
      .map(([id, a]) => ({
        id,
        kind: a.kind,
        ...(a.roleId ? { roleId: a.roleId } : {}),
        runIds: [...a.runIds].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0)).slice(0, 5),
        summary: a.summary,
        count: a.count,
        lastSeenAt: new Date(a.lastSeenAt || 0).toISOString()
      }))
      .sort((a, b) => b.count - a.count || (a.lastSeenAt < b.lastSeenAt ? 1 : -1) || (a.id < b.id ? -1 : 1))
      .slice(0, EVIDENCE_MAX_ITEMS)
  } catch {
    return []
  }
}

/** True when `next` has a signal `prev` lacks or one seen more often. */
export function hasNewEvidence(prev: TeamEvidence[] | undefined, next: TeamEvidence[]): boolean {
  const before = new Map((prev ?? []).map((e) => [e.id, e.count]))
  return next.some((e) => (before.get(e.id) ?? 0) < e.count)
}
