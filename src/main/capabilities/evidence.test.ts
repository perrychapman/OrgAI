import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunRecord, TranscriptBlock, TranscriptEntry } from '@shared/types'
import { project as makeProject, role, runSummary } from '../runtime/testHelpers'
import { EVIDENCE_MAX_ITEMS, EVIDENCE_MAX_RUNS, collectEvidence, hasNewEvidence } from './evidence'

const project = makeProject({
  roles: [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read', 'Edit', 'Bash'], reportsTo: 'r-lead' })
  ]
})

const agent = (id: string, roleId: string | null): AgentInstance => ({
  id,
  roleId,
  roleSlug: roleId ?? 'x',
  name: id,
  parentId: null,
  spawnToolUseId: null,
  state: 'done',
  activity: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 0
})

let seq = 0
const entry = (agentId: string, block: TranscriptBlock, at = 1000): TranscriptEntry => ({ id: `e${++seq}`, agentId, at, block })
const use = (agentId: string, id: string, name: string, input: unknown = {}, at = 1000): TranscriptEntry => entry(agentId, { kind: 'tool_use', id, name, input }, at)
const result = (agentId: string, toolUseId: string, content: string, isError = true, at = 1001): TranscriptEntry =>
  entry(agentId, { kind: 'tool_result', toolUseId, content, isError }, at)

function record(id: string, transcript: TranscriptEntry[], over: Partial<RunRecord['summary']> = {}): RunRecord {
  return {
    summary: runSummary({ id, status: 'finished', startedAt: 1000, endedAt: 2000, ...over }),
    agents: { root: agent('root', 'r-lead'), eng: agent('eng', 'r-eng') },
    transcript,
    logs: []
  } as RunRecord
}

describe('collectEvidence', () => {
  it('finds permission denials, rule requests, missing tools and connections', () => {
    const rec = record('run-a', [
      use('eng', 't1', 'Bash', { command: 'npm test' }),
      result('eng', 't1', 'Permission to use Bash has been denied: permission denied'),
      use('eng', 't2', 'mcp__orgai__request_permission_rules', { rules: ['Bash(npm test:*)'], reason: 'run tests' }),
      use('root', 't3', 'mcp__orgai__search_mcp_registry', { query: 'linear' }),
      use('eng', 't5', 'FancyTool'),
      result('eng', 't5', 'Error: No such tool available: FancyTool')
    ])
    const ev = collectEvidence(project, [rec])
    expect(ev.map((e) => e.kind).sort()).toEqual(['missingConnection', 'missingTool', 'permissionDenied', 'ruleRequest'])
    expect(ev.find((e) => e.kind === 'permissionDenied')).toMatchObject({ roleId: 'r-eng', runIds: ['run-a'], count: 1 })
    expect(ev.find((e) => e.kind === 'ruleRequest')!.summary).toContain('Bash(npm test:*)')
    expect(ev.find((e) => e.kind === 'missingConnection')).toMatchObject({ roleId: 'r-lead' })
    for (const e of ev) {
      expect(e.id).toMatch(/^ev-[0-9a-f]{16}$/)
      expect(new Date(e.lastSeenAt).getTime()).toBeGreaterThan(0)
    }
  })

  it('has stable ids and counts one signal across runs, newest first, max 5 run ids', () => {
    const recs = Array.from({ length: 7 }, (_, i) => record(`run-${i}`, [use('eng', 'a', 'Bash'), result('eng', 'a', 'The user denied permission')], { endedAt: 2000 + i }))
    const ev = collectEvidence(project, recs)
    expect(ev).toHaveLength(1)
    expect(ev[0]!.count).toBe(7)
    expect(ev[0]!.runIds).toEqual(['run-6', 'run-5', 'run-4', 'run-3', 'run-2'])
    expect(collectEvidence(project, [...recs].reverse())[0]!.id).toBe(ev[0]!.id)
  })

  it('reads work runs only and the newest 20', () => {
    const base = [use('eng', 'a', 'Bash'), result('eng', 'a', 'Permission denied for tool')]
    expect(collectEvidence(project, [record('s', base, { kind: 'setup' })])).toEqual([])
    const many = Array.from({ length: 25 }, (_, i) => record(`r${i}`, base, { endedAt: 5000 + i }))
    const ev = collectEvidence(project, many)
    expect(EVIDENCE_MAX_RUNS).toBe(20)
    expect(ev[0]!.count).toBe(20)
    expect(ev[0]!.runIds[0]).toBe('r24')
  })

  it('redacts keys, home paths and long ids and clamps the summary', () => {
    const rules = ['Bash(curl -H "Authorization: Bearer sk-abcdefghijklmnop1234" C:\\Users\\alice\\proj/x ' + 'z'.repeat(40) + ':*)']
    const rec = record('run-a', [
      use('eng', 'a', 'request_permission_rules', { rules }),
      use('eng', 'b', 'request_permission_rules', { rules: ['Bash(' + 'q'.repeat(500) + ')'] })
    ])
    const ev = collectEvidence(project, [rec])
    expect(ev.length).toBeGreaterThan(0)
    const all = ev.map((e) => e.summary).join('\n')
    expect(all).not.toContain('sk-abcdefghijklmnop1234')
    expect(all).not.toContain('alice')
    expect(all).not.toContain('z'.repeat(40))
    for (const e of ev) expect(e.summary.length).toBeLessThanOrEqual(300)
  })

  it('finds repeated tool sequences and corrections across runs', () => {
    const seqRun = (id: string): RunRecord =>
      record(id, [
        use('root', `${id}1`, 'Read'),
        use('root', `${id}2`, 'Grep'),
        use('root', `${id}3`, 'Edit'),
        use('root', `${id}4`, 'Bash'),
        entry('root', { kind: 'user', text: 'First task' }),
        entry('root', { kind: 'user', text: 'No, use tabs instead of spaces in every file' })
      ])
    const ev = collectEvidence(project, [seqRun('a'), seqRun('b'), seqRun('c')])
    expect(ev.some((e) => e.kind === 'repeatedSequence')).toBe(true)
    expect(ev.some((e) => e.kind === 'repeatedCorrection')).toBe(true)
  })

  it('caps the list', () => {
    const t = Array.from({ length: 80 }, (_, i) => [use('eng', `u${i}`, `FancyTool${i}`), result('eng', `u${i}`, 'No such tool available')]).flat()
    expect(collectEvidence(project, [record('a', t)])).toHaveLength(EVIDENCE_MAX_ITEMS)
  })

  it('never throws on odd records', () => {
    const odd = { summary: runSummary({ status: 'finished' }), agents: {}, transcript: [entry('x', { kind: 'tool_result', toolUseId: 'nope', content: 'denied', isError: true })], logs: [] } as unknown as RunRecord
    expect(() => collectEvidence(project, [odd, null as unknown as RunRecord, {} as RunRecord])).not.toThrow()
  })
})

describe('hasNewEvidence', () => {
  const ev = (id: string, count: number) => ({ id, kind: 'permissionDenied' as const, runIds: [], summary: '', count, lastSeenAt: '' })
  it('is true for a new signal or a higher count only', () => {
    expect(hasNewEvidence(undefined, [])).toBe(false)
    expect(hasNewEvidence(undefined, [ev('a', 1)])).toBe(true)
    expect(hasNewEvidence([ev('a', 1)], [ev('a', 1)])).toBe(false)
    expect(hasNewEvidence([ev('a', 1)], [ev('a', 2)])).toBe(true)
    expect(hasNewEvidence([ev('a', 3)], [ev('a', 2)])).toBe(false)
  })
})
