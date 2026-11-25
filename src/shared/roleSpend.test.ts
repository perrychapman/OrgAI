import { describe, expect, it } from 'vitest'
import type { Role } from './types'
import { settleSpend } from './roleSpend'

const base: Role = { id: 'd', slug: 'd', name: 'Dev', description: '', responsibilities: [], prompt: '', tools: [], model: 'm-everyday', tier: 'everyday', effort: 'medium', canSpawn: false, spawnable: [], reportsTo: 'lead', position: { x: 0, y: 0 }, color: '#000' }

describe('settleSpend on a Role (the CLI role editor reads the team files gate rule from here)', () => {
  it('holds a higher tier and a raised effort, applies lower ones', () => {
    const up = settleSpend(base, { ...base, tier: 'deep', model: 'm-deep', effort: 'high' }, [undefined], 'Dev')
    expect(up.held.map((h) => h.summary)).toEqual(["Dev's model changes and may spend more.", "Dev's reasoning effort is raised and may spend more."])
    const down = settleSpend(base, { ...base, tier: 'fast', model: 'm-fast', effort: 'low' }, [undefined], 'Dev')
    expect(down.held).toEqual([])
    expect(down.apply).toEqual(['tier', 'model', 'effort'])
  })

  it('a raised staffing ceiling is held with the gate sentence', () => {
    const r = settleSpend(base, { ...base, staffing: { mode: 'auto', maxEffort: 'max' } }, [undefined], 'Dev')
    expect(r.held[0].summary).toBe("Dev's effort ceiling is raised from medium to max. This may spend more.")
  })

  it('setting effort to low over unset applies cleanly; medium or high over unset is held (fails closed: the unset default may be low)', () => {
    const unset: Role = { ...base, effort: undefined }
    const toLow = settleSpend(unset, { ...unset, effort: 'low' }, [undefined], 'Dev')
    expect(toLow.held).toEqual([])
    expect(toLow.apply).toEqual(['effort'])

    const toMed = settleSpend(unset, { ...unset, effort: 'medium' }, [undefined], 'Dev')
    expect(toMed.held.map((h) => h.summary)).toEqual(["Dev's reasoning effort is raised and may spend more."])
    expect(toMed.apply).toEqual([])

    const toHigh = settleSpend(unset, { ...unset, effort: 'high' }, [undefined], 'Dev')
    expect(toHigh.held.map((h) => h.summary)).toEqual(["Dev's reasoning effort is raised and may spend more."])
    expect(toHigh.apply).toEqual([])
  })

  it('setting a fast floor over unset applies cleanly; everyday over unset or fast is held', () => {
    const fastFloor = settleSpend(base, { ...base, staffing: { mode: 'auto', minTier: 'fast' } }, [undefined], 'Dev')
    expect(fastFloor.held).toEqual([])
    expect(fastFloor.apply).toEqual(['staffing'])

    const everydayFloor = settleSpend(base, { ...base, staffing: { mode: 'auto', minTier: 'everyday' } }, [undefined], 'Dev')
    expect(everydayFloor.held.map((h) => h.summary)).toEqual(['Dev gets a lowest tier of everyday. This may spend more.'])
    expect(everydayFloor.apply).toEqual([])

    const raised = settleSpend({ ...base, staffing: { mode: 'auto', minTier: 'fast' } }, { ...base, staffing: { mode: 'auto', minTier: 'everyday' } }, [undefined], 'Dev')
    expect(raised.held.map((h) => h.summary)).toEqual(["Dev's lowest tier is raised from fast to everyday. This may spend more."])
  })
})
