import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NAME_NOT_SAVED, NAME_REFUSED, saveDisplayName } from './dashboardName'

type Stored = Record<string, unknown>

/** A fake settings store that behaves like main: the payload is merged over the stored object, then normalised. */
function fakeOrgai(initial: Stored, opts: { drop?: boolean; fail?: boolean } = {}): { stored: Stored; sets: Stored[]; get: () => Promise<Stored>; set: (p: Stored) => Promise<Stored> } {
  const state = { stored: { ...initial, dataDir: '/d', appVersion: '1' } as Stored, sets: [] as Stored[] }
  return {
    get stored() {
      return state.stored
    },
    sets: state.sets,
    get: async () => ({ ...state.stored }),
    set: async (p: Stored) => {
      state.sets.push(p)
      if (opts.fail) throw new Error('boom')
      const merged = { ...state.stored, ...p }
      if (typeof merged.displayName !== 'string') delete merged.displayName
      if (opts.drop) delete merged.displayName
      state.stored = merged
      return { ...merged }
    }
  }
}

function install(fake: ReturnType<typeof fakeOrgai>): void {
  vi.stubGlobal('window', { orgai: { settings: { get: fake.get, set: fake.set } } })
}

describe('saveDisplayName', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('saves a cleaned name and keeps the other settings, without dataDir and appVersion', async () => {
    const fake = fakeOrgai({ theme: 'dark' })
    install(fake)
    await saveDisplayName('  Sam   Lee ')
    expect(fake.sets).toHaveLength(1)
    expect(fake.sets[0]).toEqual({ theme: 'dark', displayName: 'Sam Lee' })
    expect('dataDir' in fake.sets[0]!).toBe(false)
    expect('appVersion' in fake.sets[0]!).toBe(false)
  })

  it('clears with an own displayName: undefined for null and for blank text', async () => {
    const fake = fakeOrgai({ displayName: 'Sam' })
    install(fake)
    await saveDisplayName(null)
    expect(Object.prototype.hasOwnProperty.call(fake.sets[0], 'displayName')).toBe(true)
    expect(fake.sets[0]!.displayName).toBeUndefined()
    expect(fake.stored.displayName).toBeUndefined()
    fake.stored.displayName = 'Sam'
    await saveDisplayName('   ')
    expect(Object.prototype.hasOwnProperty.call(fake.sets[1], 'displayName')).toBe(true)
    expect(fake.sets[1]!.displayName).toBeUndefined()
  })

  it('refuses a name over 40 characters or with hidden characters without writing', async () => {
    const fake = fakeOrgai({})
    install(fake)
    await expect(saveDisplayName('x'.repeat(41))).rejects.toThrow(NAME_REFUSED)
    await expect(saveDisplayName('Sam​')).rejects.toThrow(NAME_REFUSED)
    expect(fake.sets).toHaveLength(0)
    await expect(saveDisplayName('x'.repeat(40))).resolves.toBeUndefined()
  })

  it('throws "The name was not saved." when the saved result lacks the name, and never puts the name in the error', async () => {
    const fake = fakeOrgai({}, { drop: true })
    install(fake)
    const err = await saveDisplayName('Sam').catch((e: Error) => e)
    expect((err as Error).message).toBe(NAME_NOT_SAVED)
    expect((err as Error).message).not.toContain('Sam')
  })

  it('passes a failed write through and keeps the queue usable', async () => {
    const failing = fakeOrgai({}, { fail: true })
    install(failing)
    await expect(saveDisplayName('Sam')).rejects.toThrow('boom')
    const ok = fakeOrgai({})
    install(ok)
    await expect(saveDisplayName('Sam')).resolves.toBeUndefined()
  })

  it('serialises two saves: the second reads what the first wrote', async () => {
    const fake = fakeOrgai({})
    install(fake)
    await Promise.all([saveDisplayName('Ann'), saveDisplayName('Bo')])
    expect(fake.sets.map((s) => s.displayName)).toEqual(['Ann', 'Bo'])
    expect(fake.stored.displayName).toBe('Bo')
  })
})
