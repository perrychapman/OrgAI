import { createHash } from 'node:crypto'
import type { Project, RunRecord, TeamEvidence, TeamEvidenceKind } from '@shared/types'
import { gapFindings } from '../skills/evaluate'
import { redactEvidence } from '../skills/suggest'
import { digestKey, digestRun, hideHome, isRunDigest, type RunDigest } from '../store/runDigest'
import { clampText } from './sanitize'

/**
 * Token-free signals from finished work runs for the Team review: permission denials, permission rule requests,
 * tools a role asked for that it lacks, connections it asked for, repeated tool sequences and repeated corrections.
 * Summaries are redacted (keys, tokens, long ids) and clamped; they are untrusted text. Pure; never throws.
 *
 * Reads per-run digests (store/runDigest.ts: RunStore.getDigest caches one beside each record), not transcripts. A run
 * given as a record is digested first, so there is one implementation. The digest holds the text of its signals already
 * redacted, so a key built from it can differ from one built from the raw text (a secret or a home folder in a rule):
 * that signal gets a new id once.
 */

/** Work runs looked at, newest first. */
export const EVIDENCE_MAX_RUNS = 20
export const EVIDENCE_MAX_ITEMS = 20
const SUMMARY_MAX = 300

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

/** The work runs among `inputs` as digests (a record is digested, an odd one skipped), newest first, at most EVIDENCE_MAX_RUNS. */
function recentWorkDigests(inputs: readonly (RunRecord | RunDigest)[]): RunDigest[] {
  const out: RunDigest[] = []
  for (const x of inputs) {
    try {
      if (!x || !x.summary) continue
      if (isRunDigest(x)) out.push(x)
      else if (Array.isArray(x.transcript)) out.push(digestRun(x))
    } catch {
      // A record that cannot be digested is skipped.
    }
  }
  return out
    .filter((d) => d.summary.kind === 'work')
    .sort((a, b) => (b.summary.endedAt ?? b.summary.startedAt) - (a.summary.endedAt ?? a.summary.startedAt))
    .slice(0, EVIDENCE_MAX_RUNS)
}

export function collectEvidence(project: Project, inputs: readonly (RunRecord | RunDigest)[]): TeamEvidence[] {
  try {
    const runs = recentWorkDigests(inputs)
    const roleName = (id: string | undefined): string => project.roles.find((r) => r.id === id)?.name ?? 'An agent'
    // A digest holds role ids as digestKey writes them; the project's own role id is what the evidence carries.
    const roleByKey = new Map(project.roles.map((r) => [digestKey(r.id), r.id]))
    const acc = new Map<string, Acc>()
    const add = (kind: TeamEvidenceKind, roleId: string | undefined, key: string, text: string, runId: string, at: number, count: number): void => {
      const id = evidenceId(kind, roleId, key)
      const e = acc.get(id)
      if (e) {
        e.count += count
        if (!e.runIds.includes(runId)) e.runIds.push(runId)
        e.lastSeenAt = Math.max(e.lastSeenAt, at)
      } else acc.set(id, { kind, roleId, key, summary: summary(text), runIds: [runId], count, lastSeenAt: at })
    }
    for (const run of runs) {
      const runId = run.summary.id
      for (const e of run.evidence) {
        const roleId = e.roleId ? roleByKey.get(e.roleId) : undefined
        if (e.kind === 'ruleRequest') {
          const key = e.rules.join(',') || 'rules'
          add('ruleRequest', roleId, key, `${roleName(roleId)} asked for permission rules${e.rules.length ? `: ${e.rules.join(', ')}` : ''}.`, runId, e.lastAt, e.count)
        } else if (e.kind === 'missingConnection') {
          add('missingConnection', roleId, `${e.tool}:${e.what.toLowerCase().slice(0, 60)}`, `${roleName(roleId)} looked for a connection${e.what ? ` (${e.what})` : ''}.`, runId, e.lastAt, e.count)
        } else if (e.kind === 'missingTool') {
          const tool = e.tool ?? 'a tool'
          add('missingTool', roleId, tool, `${roleName(roleId)} tried ${tool}, which it does not have.`, runId, e.lastAt, e.count)
        } else {
          const tool = e.tool ?? 'a tool'
          add('permissionDenied', roleId, tool, `${roleName(roleId)} was denied ${tool}.`, runId, e.lastAt, e.count)
        }
      }
    }
    const newest = (ids: string[]): number => Math.max(0, ...runs.filter((r) => ids.includes(r.summary.id)).map((r) => r.summary.endedAt ?? r.summary.startedAt))
    // Repeated tool sequences and corrections come from the skill evaluation's own checks (skills/evaluate.ts), once.
    for (const f of gapFindings(runs)) {
      const ids = f.evidence?.runIds ?? []
      if (f.kind === 'repeatedToolSequence') {
        const key = (f.evidence?.sequence ?? []).join('>')
        acc.set(evidenceId('repeatedSequence', undefined, key), { kind: 'repeatedSequence', key, summary: summary(`${f.title}. ${f.detail}`), runIds: [...ids], count: ids.length, lastSeenAt: newest(ids) })
      } else if (f.kind === 'repeatedCorrection') {
        const key = f.detail.toLowerCase().slice(0, 120)
        acc.set(evidenceId('repeatedCorrection', undefined, key), { kind: 'repeatedCorrection', key, summary: summary(f.detail), runIds: [...ids], count: f.evidence?.count ?? ids.length, lastSeenAt: newest(ids) })
      }
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
