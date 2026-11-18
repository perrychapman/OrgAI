import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { ROSTER_REASONS, applyRosterChange, liveRosterApplies, rosterChanged, rosterOf } from './runRoster'
import { orgChart, role } from './testHelpers'

const running = (): Role[] => {
  const roles = orgChart()
  roles[0].effort = 'high'
  roles[1].mcpServers = ['m1']
  roles[1].skills = ['s1']
  return roles
}
/** The saved chart after an approval: a copy of `roles` with edits. */
const savedFrom = (roles: Role[], edit: (r: Role[]) => Role[]): Role[] => edit(structuredClone(roles))

describe('applyRosterChange: an approved org chart in the same run', () => {
  it('adds a new role at the end with no grants, keeping every existing object', () => {
    const run = running()
    const held = [...run]
    const saved = savedFrom(run, (r) => [...r, role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead', mcpServers: ['m1'], skills: ['s1'] })])
    const { change, retired } = applyRosterChange({ running: run, saved, proposed: saved })
    expect(change).toEqual({ added: ['r-qa'], changed: [], removed: [], deferred: [] })
    expect(retired).toEqual([])
    expect(run.map((r) => r.id)).toEqual(['r-lead', 'r-eng', 'r-rev', 'r-qa'])
    held.forEach((r, i) => expect(run[i]).toBe(r))
    // An org change never grants (review H1): a new role starts with none even if the saved copy had some.
    expect(run[3].mcpServers).toBeUndefined()
    expect(run[3].skills).toBeUndefined()
    // Not shared with the saved project.
    expect(run[3]).not.toBe(saved[3])
  })

  it('rewrites a changed role in its own object and keeps its grants; position alone is not a change', () => {
    const run = running()
    const eng = run[1]
    const saved = savedFrom(run, (r) => {
      r[1] = { ...r[1], name: 'Builder', prompt: 'New prompt', tools: ['Read'], mcpServers: ['m9'], skills: [] }
      r[2] = { ...r[2], position: { x: 9, y: 9 } }
      return r
    })
    const { change } = applyRosterChange({ running: run, saved, proposed: saved })
    expect(change.changed).toEqual(['r-eng'])
    expect(run[1]).toBe(eng)
    expect(eng).toMatchObject({ name: 'Builder', prompt: 'New prompt', tools: ['Read'], mcpServers: ['m1'], skills: ['s1'] })
  })

  it('drops a field the new version no longer has', () => {
    const run = running()
    run[1].requiredReports = []
    const saved = savedFrom(run, (r) => {
      delete r[1].requiredReports
      return r
    })
    expect(applyRosterChange({ running: run, saved, proposed: saved }).change.changed).toEqual(['r-eng'])
    expect('requiredReports' in run[1]).toBe(false)
  })

  it('the root takes prompt and spawnable but keeps its model, tier, effort and connection', () => {
    const run = running()
    const root = run[0]
    const saved = savedFrom(run, (r) => {
      r[0] = { ...r[0], prompt: 'Lead better', spawnable: ['r-eng'], model: 'opus', tier: 'deep', effort: 'low' }
      return r
    })
    const { change } = applyRosterChange({ running: run, saved, proposed: saved })
    expect(change.changed).toEqual(['r-lead'])
    expect(run[0]).toBe(root)
    expect(root).toMatchObject({ prompt: 'Lead better', spawnable: ['r-eng'], model: 'sonnet', effort: 'high' })
    expect(root.tier).toBeUndefined()
  })

  it('a root change in model only is no change', () => {
    const run = running()
    const saved = savedFrom(run, (r) => {
      r[0] = { ...r[0], model: 'opus' }
      return r
    })
    expect(rosterChanged(applyRosterChange({ running: run, saved, proposed: saved }).change)).toBe(false)
  })

  it('removes a role the chart and the saved project no longer have, returning its copy', () => {
    const run = running()
    const saved = savedFrom(run, (r) => r.filter((x) => x.id !== 'r-rev'))
    const { change, retired } = applyRosterChange({ running: run, saved, proposed: saved })
    expect(change.removed).toEqual(['r-rev'])
    expect(run.map((r) => r.id)).toEqual(['r-lead', 'r-eng'])
    expect(retired.map((r) => [r.id, r.name])).toEqual([['r-rev', 'Reviewer']])
  })

  it('a team-file pull in the same save never moves: an unnamed role keeps its definition, a pulled role does not join, a pulled removal does not remove', () => {
    const run = running()
    // Approved: engineer renamed. Pulled in the same save: reviewer prompt edit and a new 'pulled' role.
    const saved = savedFrom(run, (r) => {
      r[1] = { ...r[1], name: 'Builder' }
      r[2] = { ...r[2], prompt: 'INGESTED' }
      return [...r, role({ id: 'r-pulled', slug: 'pulled', reportsTo: 'r-lead' })]
    })
    const card = [saved[0], { ...saved[1] }]
    // The reviewer is not in the proposal but the saved project still has it: not removed.
    const { change } = applyRosterChange({ running: run, saved, proposed: card })
    expect(change).toEqual({ added: [], changed: ['r-eng'], removed: [], deferred: [] })
    expect(run[2].prompt).toBe('You are reviewer.')
    expect(run.some((r) => r.id === 'r-pulled')).toBe(false)
  })

  it('of a role the card names, only the fields the card changed move; a pulled field stays, a normalised one is saved', () => {
    const run = running()
    const card = structuredClone(run)
    card[1] = { ...card[1], name: 'Builder', model: 'opus' }
    card[2] = { ...card[2] }
    // The save normalised the card's model and a pull edited the engineer's prompt and the reviewer's tools.
    const saved = structuredClone(card)
    saved[1] = { ...saved[1], model: 'claude-opus-x', prompt: 'PULLED' }
    saved[2] = { ...saved[2], tools: ['Bash'] }
    const { change } = applyRosterChange({ running: run, saved, proposed: card })
    expect(change).toEqual({ added: [], changed: ['r-eng'], removed: [], deferred: [] })
    expect(run[1]).toMatchObject({ name: 'Builder', model: 'claude-opus-x', prompt: 'You are engineer.' })
    expect(run[2].tools).toEqual(['Read', 'Grep'])
  })

  it('defers everything when the chart has a different root', () => {
    const run = running()
    const saved = savedFrom(run, (r) => {
      r[0] = { ...r[0], reportsTo: 'r-eng' }
      r[1] = { ...r[1], reportsTo: null, name: 'Builder' }
      return r
    })
    const before = structuredClone(run)
    const { change } = applyRosterChange({ running: run, saved, proposed: saved })
    expect(rosterChanged(change)).toBe(false)
    expect(change.deferred.map((d) => d.reason)).toEqual([ROSTER_REASONS.root, ROSTER_REASONS.root, ROSTER_REASONS.root])
    expect(run).toEqual(before)
  })

  it('defers a role `refuse` names, new or changed, and never asks for the root', () => {
    const run = running()
    const saved = savedFrom(run, (r) => {
      r[0] = { ...r[0], prompt: 'p2' }
      r[1] = { ...r[1], connection: 'openai' }
      return [...r, role({ id: 'r-far', slug: 'far', reportsTo: 'r-lead', connection: 'openai' })]
    })
    const asked: string[] = []
    const { change } = applyRosterChange({
      running: run,
      saved,
      proposed: saved,
      refuse: (r, before) => {
        asked.push(`${r.id}:${before ? 'changed' : 'new'}`)
        return r.connection === 'openai' ? 'elsewhere' : undefined
      }
    })
    expect(asked).toEqual(['r-eng:changed', 'r-far:new'])
    expect(change.changed).toEqual(['r-lead'])
    expect(change.deferred).toEqual([
      { id: 'r-eng', name: 'Engineer', reason: 'elsewhere' },
      { id: 'r-far', name: 'far', reason: 'elsewhere' }
    ])
    expect(run[1].connection).toBeUndefined()
    expect(run).toHaveLength(3)
  })

  it('keeps a role a required delegation depends on: no removal, no spawn change that breaks the obligation', () => {
    const run = running()
    const saved = savedFrom(run, (r) => {
      r[0] = { ...r[0], spawnable: ['r-eng'] }
      return r.filter((x) => x.id !== 'r-rev')
    })
    const obligations = { 'r-lead': ['r-rev'] }
    const { change } = applyRosterChange({ running: run, saved, proposed: saved, obligations })
    expect(change.removed).toEqual([])
    expect(change.changed).toEqual([])
    expect(change.deferred.map((d) => [d.id, d.reason])).toEqual([
      ['r-lead', ROSTER_REASONS.delegation],
      ['r-rev', ROSTER_REASONS.delegation]
    ])
    expect(run.map((r) => r.id)).toEqual(['r-lead', 'r-eng', 'r-rev'])
  })
})

describe('rosterOf and liveRosterApplies', () => {
  it('lists running roles (added marked) then removed ones', () => {
    const run = running()
    const retired = [role({ id: 'r-old', slug: 'old', name: 'Old', reportsTo: 'r-lead', color: '#123' })]
    expect(rosterOf(run, retired, new Set(['r-rev']))).toEqual([
      { id: 'r-lead', slug: 'lead', name: 'Lead', color: '#fff', reportsTo: null },
      { id: 'r-eng', slug: 'engineer', name: 'Engineer', color: '#fff', reportsTo: 'r-lead' },
      { id: 'r-rev', slug: 'reviewer', name: 'Reviewer', color: '#fff', reportsTo: 'r-lead', added: true },
      { id: 'r-old', slug: 'old', name: 'Old', color: '#123', reportsTo: 'r-lead', removed: true }
    ])
    expect(structuredClone(rosterOf(run, retired, new Set()))).toEqual(rosterOf(run, retired, new Set()))
  })

  it('applies to team work runs of a stored project whose session declares liveRoster only', () => {
    const on = { liveRoster: true }
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, on)).toBe(true)
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, {})).toBe(false)
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, undefined)).toBe(false)
    expect(liveRosterApplies({ kind: 'setup', projectId: 'p1' }, on)).toBe(false)
    expect(liveRosterApplies({ kind: 'mcp-assist', projectId: 'harness' }, on)).toBe(false)
    expect(liveRosterApplies({ kind: 'work', projectId: 'quick', quick: {} as never }, on)).toBe(false)
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1', team: 'single' }, on)).toBe(false)
  })
})
