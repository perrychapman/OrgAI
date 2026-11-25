import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunRecord, TranscriptBlock, TranscriptEntry } from '@shared/types'
import { project as makeProject, role, runSummary } from '../runtime/testHelpers'
import { digestRun, type RunDigest } from '../store/runDigest'
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

  it('keeps no credential value in a rule, a search or a repeated correction, in any form', () => {
    const forms = [
      'git clone https://deploy:S3cr3tPw@git.example/r.git',
      'curl -u admin:S3cr3tPw https://x.example',
      'mysql --password S3cr3tPw db',
      'mysql --password "S3cr3t Pw" db',
      'tool --token S3cr3tPw run',
      'curl --header "Authorization: Basic S3cr3tPw==" x',
      'curl --header Authorization: Bearer S3cr3tPw x',
      "curl -H 'X-Api-Key: S3cr3tPw' x",
      'tool --auth S3cr3tPw x',
      'tool --bearer S3cr3tPw x',
      'DB_PASSWORD=S3cr3tPw npm test'
    ]
    for (const text of forms) {
      const mk = (id: string): RunRecord =>
        record(id, [
          use('eng', `${id}1`, 'mcp__orgai__request_permission_rules', { rules: [`Bash(${text})`] }),
          use('root', `${id}2`, 'mcp__orgai__search_mcp_registry', { query: text }),
          entry('root', { kind: 'user', text: 'First task' }),
          entry('root', { kind: 'user', text: `No, I told you again: always run ${text} the safe way and never skip it` })
        ])
      const recs = [mk('a'), mk('b'), mk('c')]
      for (const input of [recs, recs.map(digestRun)]) {
        const ev = collectEvidence(project, input)
        expect(ev.some((e) => e.kind === 'ruleRequest'), text).toBe(true)
        expect(ev.some((e) => e.kind === 'missingConnection'), text).toBe(true)
        expect(ev.some((e) => e.kind === 'repeatedCorrection'), text).toBe(true)
        expect(JSON.stringify(ev), text).not.toMatch(/S3cr3t|admin:|deploy:/)
      }
      expect(JSON.stringify(recs.map(digestRun)), text).not.toMatch(/S3cr3t|admin:|deploy:/)
    }
  })

  it('orders equal counts and times by id, whatever the input order', () => {
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
    const mk = (order: string[]): RunRecord => record('run-a', order.flatMap((n, i) => [use('eng', `u${i}`, n), result('eng', `u${i}`, 'No such tool available', true, 1000)]), { endedAt: 5000 })
    const forward = collectEvidence(project, [mk(names)])
    const backward = collectEvidence(project, [mk([...names].reverse())])
    const shuffled = collectEvidence(project, [mk(['Delta', 'Foxtrot', 'Alpha', 'Echo', 'Charlie', 'Bravo'])])
    expect(forward).toHaveLength(6)
    expect(new Set(forward.map((e) => `${e.count}|${e.lastSeenAt}`)).size).toBe(1)
    expect(forward.map((e) => e.id)).toEqual([...forward.map((e) => e.id)].sort())
    expect(backward).toEqual(forward)
    expect(shuffled).toEqual(forward)
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

  describe('from digests', () => {
    const idOf = (kind: string, roleId: string | undefined, key: string): string => `ev-${createHash('sha256').update(`${kind}\0${roleId ?? ''}\0${key}`).digest('hex').slice(0, 16)}`
    const fixture = (): RunRecord[] => {
      const seqRun = (id: string, at: number): RunRecord =>
        record(
          id,
          [
            use('root', `${id}1`, 'Read'),
            use('root', `${id}2`, 'Grep'),
            use('root', `${id}3`, 'Edit'),
            use('root', `${id}4`, 'Bash'),
            use('eng', `${id}5`, 'Bash', { command: 'npm test' }),
            result('eng', `${id}5`, 'Permission denied for Bash'),
            use('eng', `${id}6`, 'mcp__orgai__request_permission_rules', { rules: ['Bash(npm test:*)'] }),
            use('root', `${id}7`, 'mcp__orgai__search_mcp_registry', { query: 'Linear' }),
            use('eng', `${id}8`, 'FancyTool'),
            result('eng', `${id}8`, 'Error: No such tool available: FancyTool'),
            entry('root', { kind: 'user', text: 'First task' }),
            entry('root', { kind: 'user', text: 'No, use tabs instead of spaces in every file' })
          ],
          { endedAt: at }
        )
      return [seqRun('a', 3000), seqRun('b', 3100), seqRun('c', 3200), record('setup', [], { kind: 'setup' })]
    }

    it('gives the same evidence as the records, also after the digest went through JSON (the sidecar)', () => {
      const records = fixture()
      const fromRecords = collectEvidence(project, records)
      const digests = records.map((r) => JSON.parse(JSON.stringify(digestRun(r))) as RunDigest)
      expect(fromRecords.length).toBeGreaterThan(5)
      expect(collectEvidence(project, digests)).toEqual(fromRecords)
      // A mix of both is fine too.
      expect(collectEvidence(project, [records[0]!, digests[1]!, digests[2]!, digests[3]!])).toEqual(fromRecords)
    })

    it('keeps the ids the records gave for plain text (no secret, no home folder)', () => {
      const ev = collectEvidence(project, fixture())
      const ids = new Set(ev.map((e) => e.id))
      expect(ids.has(idOf('permissionDenied', 'r-eng', 'Bash'))).toBe(true)
      expect(ids.has(idOf('missingTool', 'r-eng', 'FancyTool'))).toBe(true)
      expect(ids.has(idOf('ruleRequest', 'r-eng', 'Bash(npm test:*)'))).toBe(true)
      expect(ids.has(idOf('missingConnection', 'r-lead', 'search_mcp_registry:linear'))).toBe(true)
      expect(ids.has(idOf('repeatedSequence', undefined, 'Read>Grep>Edit>Bash'))).toBe(true)
      expect(ev.find((e) => e.kind === 'permissionDenied')).toMatchObject({ count: 3, runIds: ['c', 'b', 'a'] })
    })

    it('a secret in a rule gives the redacted key, so that one signal gets a new id once', () => {
      const raw = 'Bash(curl -H "Authorization: Bearer sk-abcdefghijklmnop1234" x:*)'
      const rec = record('run-a', [use('eng', 'a', 'mcp__orgai__request_permission_rules', { rules: [raw] })])
      const [e] = collectEvidence(project, [rec])
      expect(e!.id).not.toBe(idOf('ruleRequest', 'r-eng', raw))
      expect(e!.summary).not.toContain('sk-abcdefghijklmnop1234')
      expect(collectEvidence(project, [digestRun(rec)])[0]!.id).toBe(e!.id)
    })

    it('never shows a hashed tool key to the person, and keeps the same id', () => {
      const odd = 'Weird Tool/name with spaces'
      const rec = record('run-a', [use('eng', 'a', odd), result('eng', 'a', 'Permission to use it has been denied: permission denied')])
      const [e] = collectEvidence(project, [rec])
      expect(e!.summary).toBe('Engineer was denied a tool.')
      expect(e!.summary).not.toContain('#')
      expect(collectEvidence(project, [digestRun(rec)])[0]!.id).toBe(e!.id)
    })

    it('maps a role the project does not have to no role, as before', () => {
      const rec = record('run-a', [use('ghost', 'a', 'Bash'), result('ghost', 'a', 'Permission denied')])
      rec.agents.ghost = agent('ghost', 'r-gone')
      expect(collectEvidence(project, [rec])).toMatchObject([{ kind: 'permissionDenied', summary: 'An agent was denied Bash.' }])
      expect(collectEvidence(project, [rec])[0]).not.toHaveProperty('roleId')
    })
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
