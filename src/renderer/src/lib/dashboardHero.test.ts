import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { HERO_CHAT_TARGET, heroCanStart, heroPermissionLabel, heroScopeLabel, heroTargets, pickHeroTarget } from './dashboardHero'

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({ id, name, roles: [], ...extra }) as unknown as Project

describe('heroTargets', () => {
  it('lists the projects in order, then Chat', () => {
    const t = heroTargets([project('a', 'Alpha'), project('b', 'Beta', { kind: 'engagement' } as Partial<Project>)])
    expect(t.map((x) => `${x.id}:${x.kind}`)).toEqual(['a:code', 'b:engagement', `${HERO_CHAT_TARGET}:chat`])
  })
  it('is just Chat with no projects', () => {
    expect(heroTargets([])).toHaveLength(1)
  })
})

describe('pickHeroTarget', () => {
  const targets = heroTargets([project('a', 'Alpha'), project('b', 'Beta')])
  it('keeps a chosen target that still exists', () => expect(pickHeroTarget('b', 'a', targets)).toBe('b'))
  it('falls back to the preferred, then the first', () => {
    expect(pickHeroTarget('gone', 'b', targets)).toBe('b')
    expect(pickHeroTarget(null, 'gone', targets)).toBe('a')
    expect(pickHeroTarget(null, null, targets)).toBe('a')
  })
  it('is Chat when there is nothing else', () => expect(pickHeroTarget(null, null, heroTargets([]))).toBe(HERO_CHAT_TARGET))
})

describe('labels', () => {
  it('counts roles', () => {
    expect(heroScopeLabel({ roles: new Array(12).fill(null) } as unknown as Project)).toBe('Whole team · 12 roles')
    expect(heroScopeLabel({ roles: [null] } as unknown as Project)).toBe('Whole team · 1 role')
    expect(heroScopeLabel(undefined)).toBe('')
  })
  it('puts the permission mode in plain words', () => {
    expect(heroPermissionLabel('default')).toBe('Asks before risky actions')
    expect(heroPermissionLabel(undefined)).toBe('')
  })
  it('needs text to start', () => {
    expect(heroCanStart('  \n ')).toBe(false)
    expect(heroCanStart(' fix it ')).toBe(true)
  })
})
