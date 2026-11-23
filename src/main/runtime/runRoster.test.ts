import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { ROSTER_REASONS, applyRosterChange, joiningRole, liveRosterApplies, liveRosterTakesSave, rosterChanged, rosterOf } from './runRoster'
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

  it('the root keeps canSpawn (review M1): the rest of its change applies and the deferral says so', () => {
    const run = running()
    const saved = savedFrom(run, (r) => {
      r[0] = { ...r[0], canSpawn: false, prompt: 'Solo lead' }
      return r
    })
    const { change } = applyRosterChange({ running: run, saved, proposed: saved })
    expect(run[0]).toMatchObject({ canSpawn: true, prompt: 'Solo lead' })
    expect(change.changed).toEqual(['r-lead'])
    expect(change.deferred).toEqual([{ id: 'r-lead', name: 'Lead', reason: ROSTER_REASONS.rootCanSpawn }])
    // canSpawn alone: nothing applies, the deferral is still reported.
    const run2 = running()
    const only = savedFrom(run2, (r) => {
      r[0] = { ...r[0], canSpawn: false }
      return r
    })
    const second = applyRosterChange({ running: run2, saved: only, proposed: only }).change
    expect(rosterChanged(second)).toBe(false)
    expect(second.deferred.map((d) => d.reason)).toEqual([ROSTER_REASONS.rootCanSpawn])
  })

  it('defers a new role reusing the slug of a role removed earlier in the run or in this same change (review M2)', () => {
    const run = running()
    const earlier = savedFrom(run, (r) => [...r, role({ id: 'r-new1', slug: 'auditor', reportsTo: 'r-lead' })])
    const first = applyRosterChange({ running: run, saved: earlier, proposed: earlier, retiredSlugs: ['auditor'] }).change
    expect(first.added).toEqual([])
    expect(first.deferred).toEqual([{ id: 'r-new1', name: 'auditor', reason: ROSTER_REASONS.slug }])
    // The reviewer leaves and a new role takes its slug in the same change.
    const run2 = running()
    const same = savedFrom(run2, (r) => [...r.filter((x) => x.id !== 'r-rev'), role({ id: 'r-rev2', slug: 'reviewer', name: 'Reviewer 2', reportsTo: 'r-lead' })])
    const second = applyRosterChange({ running: run2, saved: same, proposed: same }).change
    expect(second.removed).toEqual(['r-rev'])
    expect(second.added).toEqual([])
    expect(second.deferred).toEqual([{ id: 'r-rev2', name: 'Reviewer 2', reason: ROSTER_REASONS.slug }])
    // A slug nobody used is fine.
    const run3 = running()
    const fresh = savedFrom(run3, (r) => [...r, role({ id: 'r-qa', slug: 'qa', reportsTo: 'r-lead' })])
    expect(applyRosterChange({ running: run3, saved: fresh, proposed: fresh, retiredSlugs: ['auditor'] }).change.added).toEqual(['r-qa'])
  })
})

describe('third review: the invariant "a field moves only if the card differs from runBaseline"', () => {
  it('a running role whose baseline differs from it (changed after the card was shown) is deferred as stale', () => {
    const run = running()
    const baseline = structuredClone(run)
    baseline[1] = { ...baseline[1], prompt: 'what the card was diffed against' }
    const card = structuredClone(baseline)
    card[1] = { ...card[1], tools: ['Read'] }
    const { change } = applyRosterChange({ running: run, saved: structuredClone(card), proposed: card, baseline })
    expect(change.changed).toEqual([])
    expect(change.deferred).toEqual([{ id: 'r-eng', name: 'Engineer', reason: ROSTER_REASONS.stale }])
    expect(run[1].tools).toEqual(['Read', 'Edit', 'Write'])
  })

  it('a card that copies a value equal to the baseline moves nothing; a value that differs moves (it is shown as a change)', () => {
    const run = running()
    const baseline = structuredClone(run)
    const card = structuredClone(run)
    card[1] = { ...card[1], prompt: 'PULLED from disk' }
    const { change } = applyRosterChange({ running: run, saved: structuredClone(card), proposed: card, baseline })
    expect(change.changed).toEqual(['r-eng'])
    expect(run[1].prompt).toBe('PULLED from disk')
    // Grants and position on the baseline are never compared.
    const run2 = running()
    const base2 = structuredClone(run2)
    base2[1] = { ...base2[1], mcpServers: ['other'], position: { x: 5, y: 5 } }
    expect(rosterChanged(applyRosterChange({ running: run2, saved: structuredClone(run2), proposed: structuredClone(run2), baseline: base2 }).change)).toBe(false)
  })

  it('a waiting role is compared with its baseline (pending) entry and joins with the view grants only (L2)', () => {
    const run = running()
    const pendingX = role({ id: 'r-x', slug: 'x', name: 'X', reportsTo: 'r-lead', prompt: 'approved on card 1', model: 'sonnet', mcpServers: ['m-ok'] })
    const baseline = [...structuredClone(run), pendingX]
    const card = [...structuredClone(run), { ...pendingX, model: 'haiku' }]
    const saved = [...structuredClone(run), { ...pendingX, model: 'claude-haiku-x', prompt: 'PULLED', mcpServers: ['m-pulled'] }]
    const { change } = applyRosterChange({ running: run, saved, proposed: card, baseline, pendingGrants: new Map([['r-x', { mcpServers: ['m-ok'] }]]) })
    expect(change.added).toEqual(['r-x'])
    expect(run[3]).toMatchObject({ prompt: 'approved on card 1', model: 'claude-haiku-x', mcpServers: ['m-ok'] })
    // Without a view grant, none.
    const run2 = running()
    applyRosterChange({ running: run2, saved, proposed: card, baseline })
    expect(run2[3].mcpServers).toBeUndefined()
  })

  it('L3: a card role the save holds under another identity is deferred with a reason, never dropped silently', () => {
    const run = running()
    // The card drops the reviewer; the save still has it, renamed by a pull to the engineer's name.
    const card = structuredClone(run).filter((r) => r.id !== 'r-rev')
    const saved = [...structuredClone(card), { ...structuredClone(run[2]), name: 'Engineer' }]
    const { change } = applyRosterChange({ running: run, saved, proposed: card })
    expect(change.deferred).toContainEqual({ id: 'r-rev', name: 'Engineer', reason: ROSTER_REASONS.unmatched })
  })

  it('L1: a partial application that would cut a role off from the root defers the role whose manager changed', () => {
    const run = running()
    run[2].reportsTo = 'r-eng'
    // Swap: the engineer reports to the reviewer, the reviewer to the lead; the reviewer's change is refused.
    const card = structuredClone(run)
    card[1] = { ...card[1], reportsTo: 'r-rev' }
    card[2] = { ...card[2], reportsTo: 'r-lead', prompt: 'p' }
    const { change } = applyRosterChange({ running: run, saved: structuredClone(card), proposed: card, refuse: (r) => (r.id === 'r-rev' ? 'later' : undefined) })
    expect(change.changed).toEqual([])
    expect(change.deferred.map((d) => [d.id, d.reason])).toEqual([
      ['r-rev', 'later'],
      ['r-eng', ROSTER_REASONS.reporting]
    ])
    expect(run.map((r) => [r.id, r.reportsTo])).toEqual([
      ['r-lead', null],
      ['r-eng', 'r-lead'],
      ['r-rev', 'r-eng']
    ])
  })
})

describe('fourth review: parallel cards', () => {
  it('M2: a running role that joined after the card was created is never removed by it (stale)', () => {
    const baseline = structuredClone(running())
    const run = running()
    // N joined through another card after this one was created; this card (and its save) do not have it.
    run.push(role({ id: 'r-n', slug: 'n', name: 'N', reportsTo: 'r-lead' }))
    const card = structuredClone(baseline)
    const { change, retired } = applyRosterChange({ running: run, saved: structuredClone(card), proposed: card, baseline })
    expect(change.removed).toEqual([])
    expect(retired).toEqual([])
    expect(change.deferred).toEqual([{ id: 'r-n', name: 'N', reason: ROSTER_REASONS.stale }])
    expect(run.some((r) => r.id === 'r-n')).toBe(true)
  })

  it('M3: a waiting role another card changed since this card was created is deferred stale and keeps its current entry', () => {
    const p = role({ id: 'r-p', slug: 'p', name: 'P', reportsTo: 'r-lead', tools: ['Read', 'Bash'], connection: 'openai' })
    const run = running()
    const baseline = [...structuredClone(run), structuredClone(p)]
    // Since then, card X removed Bash from P's waiting entry.
    const current: Role = { ...structuredClone(p), tools: ['Read'] }
    // This older card clears P's deferral (no connection) and still shows Bash.
    const card = [...structuredClone(run), { ...structuredClone(p), connection: undefined }]
    const { change, pending } = applyRosterChange({ running: run, saved: structuredClone(card), proposed: card, baseline, currentView: new Map([['r-p', current]]) })
    expect(change.added).toEqual([])
    expect(change.deferred).toEqual([{ id: 'r-p', name: 'P', reason: ROSTER_REASONS.stale }])
    expect(pending).toEqual([current])
    expect(run.some((r) => r.id === 'r-p')).toBe(false)
    // Unchanged in the view (grants aside): it joins.
    const run2 = running()
    const same2 = applyRosterChange({ running: run2, saved: structuredClone(card), proposed: card, baseline, currentView: new Map([['r-p', { ...structuredClone(p), mcpServers: ['m'] }]]) })
    expect(same2.change.added).toEqual(['r-p'])
    // A waiting role the view lost since (another card removed it): deferred, not resurrected.
    const run3 = running()
    const gone = applyRosterChange({ running: run3, saved: structuredClone(card), proposed: card, baseline, currentView: new Map() })
    expect(gone.change.deferred.map((d) => d.reason)).toEqual([ROSTER_REASONS.stale])
    expect(gone.pending).toEqual([])
  })

  it('L4: a card never changes a running role\'s slug (identity)', () => {
    const run = running()
    const card = structuredClone(run)
    card[1] = { ...card[1], slug: 'builder', prompt: 'p2' }
    const { change } = applyRosterChange({ running: run, saved: structuredClone(card), proposed: card })
    expect(change.changed).toEqual([])
    expect(change.deferred).toEqual([{ id: 'r-eng', name: 'Engineer', reason: ROSTER_REASONS.slugChange }])
    expect(run[1]).toMatchObject({ slug: 'engineer', prompt: 'You are engineer.' })
  })
})

describe('review H1 second route: the card, not the save, defines what joins or changes', () => {
  it('a joining role shown whole takes every field from its card entry (model as the save resolved it), never a saved-only field, no grants', () => {
    const run = running()
    const card = [...structuredClone(run), role({ id: 'r-x', slug: 'x', name: 'X', reportsTo: 'r-lead', prompt: 'card', tools: ['Read'], model: 'opus' })]
    const saved = structuredClone(card)
    saved[3] = { ...saved[3], model: 'claude-opus-x', tier: 'deep', prompt: 'PULLED', tools: ['Bash'], canSpawn: true, spawnable: ['r-eng'], effort: 'max', mcpServers: ['m1'] }
    const { change } = applyRosterChange({ running: run, saved, proposed: card })
    expect(change.added).toEqual(['r-x'])
    const x = run[3]
    expect(x).toMatchObject({ id: 'r-x', slug: 'x', model: 'claude-opus-x', prompt: 'card', tools: ['Read'], canSpawn: false, spawnable: [] })
    // The card carried no tier or effort: the save's never arrive.
    expect(x.tier).toBeUndefined()
    expect(x.effort).toBeUndefined()
    expect(x.mcpServers).toBeUndefined()
    expect(joiningRole(card[3], saved[3])).toEqual(x)
  })

  it('M1: a new role the save gave another identity (id or slug), or whose slug a running role has, is deferred, never joined', () => {
    const newX = role({ id: 'r-x', slug: 'x', name: 'X', reportsTo: 'r-lead', prompt: 'card' })
    // The save matched the card's X to a pulled stored role (another id and its slug).
    const run1 = running()
    const card1 = [...structuredClone(run1), newX]
    const saved1 = [...structuredClone(run1), { ...newX, id: 'r-pulled', slug: 'pulled', prompt: 'PULLED' }]
    const one = applyRosterChange({ running: run1, saved: saved1, proposed: card1 })
    expect(one.change.added).toEqual([])
    expect(one.change.deferred).toEqual([{ id: 'r-x', name: 'X', reason: ROSTER_REASONS.identity }])
    expect(one.pending.map((r) => [r.id, r.slug, r.prompt])).toEqual([['r-x', 'x', 'card']])
    // The save de-duplicated the slug.
    const run2 = running()
    const card2 = [...structuredClone(run2), newX]
    const saved2 = [...structuredClone(run2), { ...newX, slug: 'x-2' }]
    expect(applyRosterChange({ running: run2, saved: saved2, proposed: card2 }).change.deferred.map((d) => d.reason)).toEqual([ROSTER_REASONS.identity])
    // A new role with the slug of a running role.
    const run3 = running()
    const dup = { ...newX, slug: 'engineer' }
    const card3 = [...structuredClone(run3), dup]
    expect(applyRosterChange({ running: run3, saved: structuredClone(card3), proposed: card3 }).change.deferred.map((d) => d.reason)).toEqual([ROSTER_REASONS.slugTaken])
    expect(run3).toHaveLength(3)
  })

  it('a deferred joining role is returned as it would join (pending), so the run view never shows the saved one', () => {
    const run = running()
    const card = [...structuredClone(run), role({ id: 'r-x', slug: 'x', name: 'X', reportsTo: 'r-lead', prompt: 'card' })]
    const saved = structuredClone(card)
    saved[3] = { ...saved[3], prompt: 'PULLED' }
    const { change, pending } = applyRosterChange({ running: run, saved, proposed: card, refuse: () => 'later' })
    expect(change.deferred.map((d) => d.id)).toEqual(['r-x'])
    expect(pending.map((r) => [r.id, r.prompt])).toEqual([['r-x', 'card']])
  })

  it('a field the card changed takes the card value even where the save differs (a pull of the same field)', () => {
    const run = running()
    const card = structuredClone(run)
    card[1] = { ...card[1], prompt: 'card prompt', tools: ['Read', 'Grep'] }
    const saved = structuredClone(card)
    saved[1] = { ...saved[1], prompt: 'PULLED', tools: ['Bash'] }
    applyRosterChange({ running: run, saved, proposed: card })
    expect(run[1]).toMatchObject({ prompt: 'card prompt', tools: ['Read', 'Grep'] })
  })

  it('a saved role a pull renamed to another card role never takes that role\'s card entry', () => {
    const run = running()
    // The card drops the reviewer; the save still has it, renamed by a pull to the engineer's name.
    const card = structuredClone(run).filter((r) => r.id !== 'r-rev')
    const saved = [...structuredClone(card), { ...structuredClone(run[2]), name: 'Engineer', prompt: 'PULLED' }]
    applyRosterChange({ running: run, saved, proposed: card })
    const rev = run.find((r) => r.id === 'r-rev')!
    expect(rev.prompt).toBe('You are reviewer.')
    expect(rev.tools).toEqual(['Read', 'Grep'])
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
    const desktop = { liveRosterCards: true }
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, on, desktop)).toBe(true)
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, {}, desktop)).toBe(false)
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, undefined, desktop)).toBe(false)
    expect(liveRosterApplies({ kind: 'setup', projectId: 'p1' }, on, desktop)).toBe(false)
    expect(liveRosterApplies({ kind: 'mcp-assist', projectId: 'harness' }, on, desktop)).toBe(false)
    expect(liveRosterApplies({ kind: 'work', projectId: 'quick', quick: {} as never }, on, desktop)).toBe(false)
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1', team: 'single' }, on, desktop)).toBe(false)
  })

  it('fails closed on a host that did not opt in (review, fourth round: the CLI / TUI / exec host)', () => {
    const on = { liveRoster: true }
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, on, {})).toBe(false)
    expect(liveRosterApplies({ kind: 'work', projectId: 'p1' }, on, { liveRosterCards: false })).toBe(false)
  })
})

describe('liveRosterTakesSave', () => {
  const on = { liveRoster: true }
  const work = { kind: 'work' as const, projectId: 'p1' }

  it('a host that passes the user\'s saves to live runs takes a saved role edit without the card switch', () => {
    expect(liveRosterTakesSave(work, on, { liveUserSaves: true })).toBe(true)
    expect(liveRosterTakesSave(work, on, { liveRosterCards: true })).toBe(true)
    expect(liveRosterApplies(work, on, { liveUserSaves: true } as { liveRosterCards?: boolean })).toBe(false)
  })

  it('keeps every other condition of liveRosterApplies', () => {
    expect(liveRosterTakesSave(work, on, {})).toBe(false)
    expect(liveRosterTakesSave(work, {}, { liveUserSaves: true })).toBe(false)
    expect(liveRosterTakesSave(work, undefined, { liveUserSaves: true })).toBe(false)
    expect(liveRosterTakesSave({ kind: 'work', projectId: 'p1', quick: {} as never }, on, { liveUserSaves: true })).toBe(false)
    expect(liveRosterTakesSave({ kind: 'work', projectId: 'p1', team: 'single' }, on, { liveUserSaves: true })).toBe(false)
    expect(liveRosterTakesSave({ kind: 'setup', projectId: 'p1' }, on, { liveUserSaves: true })).toBe(false)
  })
})
