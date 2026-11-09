import { describe, expect, it } from 'vitest'
import type { DelegationAgentState, DelegationLedgerState, DelegationReceipt, Role } from '@shared/types'
import { attempt, correctionText, delegationPreflight, failureLine, obligationsFor, receiptLine, subtreeFailed, waitText } from './delegation'

const role = (id: string, over: Partial<Role> = {}): Role => ({
  id, slug: id, name: id.toUpperCase(), description: '', responsibilities: [], prompt: '', tools: [], model: 'inherit',
  canSpawn: false, spawnable: [], reportsTo: null, position: { x: 0, y: 0 }, color: '#000', ...over
}) as Role

const agent = (roleId: string, required: string[], over: Partial<DelegationAgentState> = {}): DelegationAgentState => ({
  roleId, required, phase: 'working', corrections: 0, missing: [], nativeStrikes: 0, ...over
})
const receipt = (childId: string, parentId: string, roleId: string, over: Partial<DelegationReceipt> = {}): DelegationReceipt => ({
  childId, parentId, roleId, completedAt: 1, verdict: 'adaptive', reportChars: 10, delivered: true, ...over
})
const ledger = (agents: Record<string, DelegationAgentState>, receipts: DelegationReceipt[] = []): DelegationLedgerState => ({
  strict: false, obligations: {}, problems: [], agents, receipts
})
const both = { canCorrect: true, canWait: true }

describe('obligationsFor', () => {
  const roles = [
    role('lead', { canSpawn: true, spawnable: ['mgr', 'rev'], requiredReports: ['mgr'] }),
    role('mgr', { canSpawn: true, spawnable: ['pol', 'evi', 'mgr'], reportsTo: 'lead' }),
    role('pol', { reportsTo: 'mgr' }), role('evi', { reportsTo: 'mgr' }), role('rev', { reportsTo: 'lead' })
  ]
  it('uses requiredReports when not strict', () => {
    expect(obligationsFor(roles, false)).toEqual({ lead: ['mgr'] })
  })
  it('strict: every spawner requires its whole spawnable list (not itself)', () => {
    expect(obligationsFor(roles, true)).toEqual({ lead: ['mgr', 'rev'], mgr: ['pol', 'evi'] })
  })
  it('ignores required reports on roles that cannot spawn', () => {
    expect(obligationsFor([role('a', { requiredReports: ['b'], spawnable: ['b'] }), role('b')], false)).toEqual({})
  })
})

describe('attempt', () => {
  it('allows adaptive agents', () => {
    expect(attempt('a', ledger({ a: agent('m', []) }), both)).toEqual({ action: 'allow', verdict: 'adaptive', missing: [] })
    expect(attempt('zz', ledger({}), both).verdict).toBe('adaptive')
  })
  it('corrects a never-spawned report once, then fails', () => {
    const l = ledger({ m: agent('mgr', ['pol']) })
    expect(attempt('m', l, both)).toEqual({ action: 'correct', missing: [{ roleId: 'pol', why: 'never-spawned' }] })
    l.agents.m.corrections = 1
    expect(attempt('m', l, both)).toEqual({ action: 'fail', verdict: 'failed', missing: [{ roleId: 'pol', why: 'never-spawned' }] })
  })
  it('fails at once when it cannot correct', () => {
    expect(attempt('m', ledger({ m: agent('mgr', ['pol']) }), { canCorrect: false, canWait: true }).action).toBe('fail')
  })
  it('waits for a running child before using any budget', () => {
    const l = ledger({ m: agent('mgr', ['pol']), c: agent('pol', [], { parentId: 'm' }) })
    expect(attempt('m', l, both)).toEqual({ action: 'wait', missing: [{ roleId: 'pol', why: 'running' }] })
    l.agents.m.corrections = 1
    expect(attempt('m', l, both).action).toBe('wait')
  })
  it('a running child with canWait false is a failure or correction', () => {
    const l = ledger({ m: agent('mgr', ['pol']), c: agent('pol', [], { parentId: 'm', phase: 'waiting' }) })
    expect(attempt('m', l, { canCorrect: true, canWait: false }).action).toBe('correct')
    expect(attempt('m', l, { canCorrect: false, canWait: false }).action).toBe('fail')
  })
  it('allows with verdict ok when every report has a valid receipt', () => {
    const l = ledger({ m: agent('mgr', ['pol', 'evi']) }, [receipt('c1', 'm', 'pol'), receipt('c2', 'm', 'evi')])
    expect(attempt('m', l, both)).toEqual({ action: 'allow', verdict: 'ok', missing: [] })
  })
  it('names each missing reason', () => {
    const l = ledger(
      { m: agent('mgr', ['a', 'b', 'c', 'd', 'e']), cb: agent('b', [], { parentId: 'm', phase: 'ended' }), cd: agent('d', [], { parentId: 'm', phase: 'done' }), ce: agent('e', [], { parentId: 'm', phase: 'done' }) },
      [receipt('cd', 'm', 'd', { delivered: false }), receipt('ce', 'm', 'e', { verdict: 'failed' }), receipt('cc', 'm', 'c', { reportChars: 0 })]
    )
    const why = Object.fromEntries(attempt('m', l, { canCorrect: false, canWait: false }).missing.map((x) => [x.roleId, x.why]))
    expect(why).toEqual({ a: 'never-spawned', b: 'ended-without-report', c: 'report-failed', d: 'not-delivered', e: 'report-failed' })
  })
  it('valid receipt: the latest delivered one wins', () => {
    const bad = ledger({ m: agent('mgr', ['pol']) }, [receipt('c1', 'm', 'pol'), receipt('c2', 'm', 'pol', { verdict: 'failed' })])
    expect(attempt('m', bad, both).missing).toEqual([{ roleId: 'pol', why: 'report-failed' }])
    const good = ledger({ m: agent('mgr', ['pol']) }, [receipt('c1', 'm', 'pol', { verdict: 'failed' }), receipt('c2', 'm', 'pol')])
    expect(attempt('m', good, both).action).toBe('allow')
    // an undelivered later receipt does not displace a delivered valid one
    const pending = ledger({ m: agent('mgr', ['pol']) }, [receipt('c1', 'm', 'pol'), receipt('c2', 'm', 'pol', { delivered: false })])
    expect(attempt('m', pending, both).action).toBe('allow')
  })
  it('a receipt only counts under the same parent', () => {
    expect(attempt('m', ledger({ m: agent('mgr', ['pol']) }, [receipt('c1', 'other', 'pol')]), both).action).toBe('correct')
  })
})

describe('delegationPreflight', () => {
  const chain = [
    role('root', { canSpawn: true, spawnable: ['a'] }),
    role('a', { canSpawn: true, spawnable: ['b'], reportsTo: 'root' }),
    role('b', { canSpawn: true, spawnable: ['c'], reportsTo: 'a' }),
    role('c', { reportsTo: 'b' })
  ]
  const obl = { root: ['a'], a: ['b'], b: ['c'] }
  it('accepts a 3-level chain at concurrency 2 on codex but not on claude', () => {
    expect(delegationPreflight(chain, obl, { depth: 4, concurrency: 2 }, 'codex', [])).toEqual([])
    expect(delegationPreflight(chain, obl, { depth: 4, concurrency: 2 }, 'claude', [])).toHaveLength(1)
    expect(delegationPreflight(chain, obl, { depth: 4, concurrency: 3 }, 'claude', [])).toEqual([])
    expect(delegationPreflight(chain, obl, { depth: 4, concurrency: 2 }, 'mock', [])).toHaveLength(1)
  })
  it('codex needs min(chain, 2) slots', () => {
    expect(delegationPreflight(chain, obl, { depth: 4, concurrency: 1 }, 'codex', [])).toHaveLength(1)
    expect(delegationPreflight(chain, { root: ['a'] }, { depth: 4, concurrency: 1 }, 'codex', [])).toEqual([])
  })
  it('reports a required role too deep', () => {
    expect(delegationPreflight(chain, obl, { depth: 3, concurrency: 9 }, 'claude', [])).toEqual([])
    const p = delegationPreflight(chain, obl, { depth: 2, concurrency: 9 }, 'claude', [])
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/depth limit is 2/)
  })
  it('reports a required edge into a bridged role', () => {
    const p = delegationPreflight(chain, { root: ['a'] }, { depth: 4, concurrency: 4 }, 'claude', ['a'])
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/not supported in v1/)
  })
  it('is empty with no obligations', () => {
    expect(delegationPreflight(chain, {}, { depth: 1, concurrency: 1 }, 'claude', ['a'])).toEqual([])
  })
})

describe('subtreeFailed', () => {
  it('is false for a healthy ledger', () => {
    expect(subtreeFailed(ledger({ r: agent('root', ['m'], { phase: 'done', verdict: 'ok' }) }))).toBe(false)
  })
  it('flags a failed or ended-without-completing agent with obligations', () => {
    expect(subtreeFailed(ledger({ r: agent('root', ['m'], { phase: 'done', verdict: 'failed' }) }))).toBe(true)
    expect(subtreeFailed(ledger({ m: agent('mgr', ['w'], { parentId: 'r', phase: 'ended' }) }))).toBe(true)
  })
  it('ignores agents without obligations', () => {
    expect(subtreeFailed(ledger({ w: agent('w', [], { parentId: 'm', phase: 'ended' }) }))).toBe(false)
  })
  it('a later valid receipt for the same (parent, role) replaces the failure', () => {
    const agents = { m1: agent('mgr', ['w'], { parentId: 'r', phase: 'done', verdict: 'failed' }), m2: agent('mgr', ['w'], { parentId: 'r', phase: 'done', verdict: 'ok' }) }
    const failedFirst = [receipt('m1', 'r', 'mgr', { verdict: 'failed' })]
    expect(subtreeFailed(ledger(agents, failedFirst))).toBe(true)
    expect(subtreeFailed(ledger(agents, [...failedFirst, receipt('m2', 'r', 'mgr', { verdict: 'ok' })]))).toBe(false)
    // ... but not an earlier one
    expect(subtreeFailed(ledger(agents, [receipt('m2', 'r', 'mgr', { verdict: 'ok' }), ...failedFirst]))).toBe(true)
    // an ended agent with no receipt is replaced by any valid one
    expect(subtreeFailed(ledger({ m1: agent('mgr', ['w'], { parentId: 'r', phase: 'ended' }) }, [receipt('m2', 'r', 'mgr', { verdict: 'ok' })]))).toBe(false)
  })
})

describe('texts', () => {
  it('correctionText follows the spec wording', () => {
    const t = correctionText({
      roleName: 'Manager',
      required: [{ slug: 'policy', name: 'Policy Analyst' }, { slug: 'evidence', name: 'Evidence Reviewer' }],
      missing: [{ slug: 'policy', why: 'never-spawned' }, { slug: 'evidence', why: 'ended-without-report' }],
      spawnTool: 'spawn_report'
    })
    expect(t).toContain('Your role (Manager) must delegate to Policy Analyst (`policy`) and Evidence Reviewer (`evidence`) and receive their reports.')
    expect(t).toContain('`policy` never spawned; `evidence` ended without a report.')
    expect(t).toContain('Spawn them now with spawn_report')
    expect(t).toContain('This is the only reminder')
  })
  it('receiptLine and failureLine', () => {
    expect(receiptLine({ handle: 'luna-1', roleName: 'Manager', required: [{ slug: 'policy', childHandle: 'policy-1' }, { slug: 'evidence', why: 'never-spawned' }] })).toBe(
      "Harness receipt for luna-1 (Manager): required policy ✔ policy-1, evidence ✗ never spawned. Trust this record over the report's own account of what it delegated."
    )
    expect(failureLine({ handle: 'luna-1', roleName: 'Manager', missing: [{ slug: 'evidence', why: 'never-spawned' }] })).toBe(
      'Harness: luna-1 (Manager) FAILED its required delegation: evidence never spawned. Its report below is unsupported on those points.'
    )
    expect(waitText({ roleName: 'Manager', missing: [{ slug: 'policy', why: 'running' }] })).toContain('still running')
  })
})
