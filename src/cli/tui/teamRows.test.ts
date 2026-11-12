import { describe, expect, it } from 'vitest'
import type { AgentInstance, Role } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { orgTreeRows, transcriptRows, partialRows } from './selectors'
import { applyRecord, createInitialState, setActiveRun } from './state'

const role = (id: string, reportsTo: string | null): Role => ({ id, slug: id, name: id, reportsTo, description: `${id} responsibilities`, responsibilities: [], prompt: '', tools: [], model: 'inherit', canSpawn: false, spawnable: [], position: { x: 0, y: 0 }, color: '' })
const roles = [role('lead', null), role('builder', 'lead'), role('reviewer', 'lead')]
const agent = (id: string, roleId: string, parentId: string | null, state: AgentInstance['state'] = 'idle'): AgentInstance => ({ id, roleId, roleSlug: roleId, parentId, name: roleId, spawnToolUseId: null, state, activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1 })
const state = () => ({ ...createInitialState('/work'), project: project('p1', '/work', { roles }) })
const withAgents = (agents: AgentInstance[]) => setActiveRun(applyRecord(state(), record(summary('r1', { status: 'running' }), { agents: Object.fromEntries(agents.map(agent => [agent.id, agent])) })), 'r1')

describe('configured team sidebar', () => {
  it('keeps distinct role colors consistent in available, live, transcript and streaming rows', () => {
    const available = orgTreeRows(state(), { includeRoles: true })
    expect(new Set(available.map(row => row.identityTone)).size).toBe(3)
    const s = withAgents([agent('root', 'lead', null), agent('worker', 'builder', 'root', 'thinking')])
    s.runs.r1.transcript = [{ id: 'text1', agentId: 'worker', at: 1, block: { kind: 'text', text: 'Building the feature.' } }]
    s.runs.r1.partials = { worker: 'Still building' }
    const tone = available.find(row => row.label === 'builder')!.identityTone
    expect(orgTreeRows(s, { includeRoles: true }).find(row => row.id === 'worker')?.identityTone).toBe(tone)
    expect(transcriptRows(s).rows.find(row => row.agentId === 'worker')?.identityTone).toBe(tone)
    expect(partialRows(s)[0].identityTone).toBe(tone)
  })
  it('shows all configured roles before a run, in reporting order', () => {
    const rows = orgTreeRows(state(), { includeRoles: true })
    expect(rows.map(row => [row.label, row.depth, row.stateWord])).toEqual([
      ['lead', 0, 'Available'], ['builder', 1, 'Available'], ['reviewer', 1, 'Available']
    ])
    expect(rows.every(row => row.kind === 'role')).toBe(true)
  })

  it('fills unstarted roles and replaces them with agents when they start', () => {
    const root = agent('root', 'lead', null)
    const rows = orgTreeRows(withAgents([root]), { includeRoles: true })
    expect(rows.map(row => row.label)).toEqual(['lead', 'builder', 'reviewer'])
    expect(rows[0].kind).not.toBe('role')
    const running = orgTreeRows(withAgents([root, agent('worker', 'builder', 'root', 'thinking')]), { includeRoles: true })
    expect(running.map(row => row.label)).toEqual(['lead', 'builder', 'reviewer'])
    expect(running.find(row => row.id === 'worker')?.state).toBe('thinking')
    expect(running.filter(row => row.kind === 'role').map(row => row.label)).toEqual(['reviewer'])
  })

  it('keeps configured agents visible after they finish and respects focused subtrees', () => {
    const s = withAgents([agent('root', 'lead', null), { ...agent('worker', 'builder', 'root', 'done'), endedAt: 2 }])
    const rows = orgTreeRows(s, { includeRoles: true, collapse: true, now: 60_000 })
    expect(rows.some(row => row.id === 'worker')).toBe(true)
    expect(rows.find(row => row.id === 'worker')?.stateWord).toBe('Finished')
    expect(orgTreeRows(s, { includeRoles: true, rootId: 'worker' }).map(row => row.id)).toEqual(['worker'])
  })

  it('folds old instances while keeping the current representative of each role', () => {
    const s = withAgents([agent('root', 'lead', null),
      { ...agent('old-worker', 'builder', 'root', 'done'), endedAt: 2 },
      { ...agent('new-worker', 'builder', 'root', 'thinking'), startedAt: 3 }])
    const rows = orgTreeRows(s, { includeRoles: true, collapse: true, now: 60_000 })
    expect(rows.some(row => row.id === 'old-worker')).toBe(false)
    expect(rows.some(row => row.id === 'new-worker')).toBe(true)
    expect(rows.some(row => row.kind === 'group')).toBe(true)
  })

  it('matches legacy agents by slug and does not duplicate roles with multiple instances', () => {
    const s = withAgents([agent('root', 'lead', null), { ...agent('w1', 'builder', 'root'), roleId: null }, agent('w2', 'builder', 'root')])
    const rows = orgTreeRows(s, { includeRoles: true })
    expect(rows.filter(row => row.kind === 'role').map(row => row.label)).toEqual(['reviewer'])
    expect(rows.filter(row => row.label === 'builder')).toHaveLength(2)
  })

  it('handles orphaned and cyclic reporting relationships without dropping roles', () => {
    const s = { ...state(), project: project('p1', '/work', { roles: [role('a', 'b'), role('b', 'a'), role('c', 'missing')] }) }
    expect(orgTreeRows(s, { includeRoles: true }).map(row => row.label).sort()).toEqual(['a', 'b', 'c'])
  })
})
