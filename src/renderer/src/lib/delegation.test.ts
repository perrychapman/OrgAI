import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { ancestorsOf, delegationChoices } from './delegation'

const role = (id: string, reportsTo: string | null, spawnable: string[] = []): Role =>
  ({ id, name: id, slug: id, reportsTo, spawnable, canSpawn: spawnable.length > 0, tools: [], responsibilities: [] }) as unknown as Role

describe('delegationChoices', () => {
  const roles = [role('root', null), role('mid', 'root'), role('me', 'mid'), role('kid', 'me'), role('kid2', 'me'), role('cousin', 'mid')]
  const me = roles[2]

  it('lists direct reports first and leaves out the manager and ancestors', () => {
    const c = delegationChoices(roles, me)
    expect(c.direct.map((r) => r.id)).toEqual(['kid', 'kid2'])
    expect(c.other.map((r) => r.id)).toEqual(['cousin'])
    expect(ancestorsOf(roles, me).map((r) => r.id)).toEqual(['mid', 'root'])
  })

  it('keeps a ticked ancestor so it can be unticked', () => {
    const c = delegationChoices(roles, { ...me, spawnable: ['mid'] })
    expect(c.other.map((r) => r.id)).toEqual(['mid', 'cousin'])
  })

  it('offers everything else for a root', () => {
    const c = delegationChoices(roles, roles[0])
    expect(c.direct.map((r) => r.id)).toEqual(['mid'])
    expect(c.other.map((r) => r.id)).toEqual(['me', 'kid', 'kid2', 'cousin'])
  })
})
