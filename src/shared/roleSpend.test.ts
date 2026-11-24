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

  it('setting effort to low or medium over unset applies cleanly; setting high over unset is held', () => {
    const unset: Role = { ...base, effort: undefined }
    const toLow = settleSpend(unset, { ...unset, effort: 'low' }, [undefined], 'Dev')
    expect(toLow.held).toEqual([])
    expect(toLow.apply).toEqual(['effort'])

    const toMed = settleSpend(unset, { ...unset, effort: 'medium' }, [undefined], 'Dev')
    expect(toMed.held).toEqual([])
    expect(toMed.apply).toEqual(['effort'])

    const toHigh = settleSpend(unset, { ...unset, effort: 'high' }, [undefined], 'Dev')
    expect(toHigh.held.map((h) => h.summary)).toEqual(["Dev's reasoning effort is raised and may spend more."])
    expect(toHigh.apply).toEqual([])
  })
})
