import { describe, expect, it } from 'vitest'
import { PROJECT_HUES, assignProjectHues, hashedHue, projectHue, projectHueVar, projectMonogram, registerProjectHues } from './projectIdentity'

describe('projectHue', () => {
  it('is stable for the same id and within 1..PROJECT_HUES', () => {
    for (const id of ['p1', 'abc', 'a-very-long-project-id-0123456789', 'été']) {
      const h = projectHue(id)
      expect(h).toBe(projectHue(id))
      expect(h).toBeGreaterThanOrEqual(1)
      expect(h).toBeLessThanOrEqual(PROJECT_HUES)
    }
  })

  it('is neutral for no project', () => {
    expect(projectHue('')).toBe(0)
    expect(projectHue(null)).toBe(0)
    expect(projectHue(undefined)).toBe(0)
  })

  it('spreads ids over every hue', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(projectHue(`project-${i}`))
    expect(seen.size).toBe(PROJECT_HUES)
  })

  it('pins known values so a refactor never recolours every project', () => {
    // FNV-1a("a") = 0xe40c292c -> 3826002220 % 8 = 4 -> hue 5
    expect(projectHue('a')).toBe(5)
  })
})

describe('assignProjectHues', () => {
  it('gives up to eight projects eight different hues, and an appended project never recolours earlier ones', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `proj-${i}`)
    const all = assignProjectHues(ids)
    expect(new Set(all.values()).size).toBe(8)
    const first5 = assignProjectHues(ids.slice(0, 5))
    for (const id of ids.slice(0, 5)) expect(all.get(id)).toBe(first5.get(id))
  })
  it('keeps the hashed hue when it is free and spreads past eight evenly', () => {
    expect(assignProjectHues(['a']).get('a')).toBe(hashedHue('a'))
    const many = assignProjectHues(Array.from({ length: 16 }, (_, i) => `x${i}`))
    const counts = new Map<number, number>()
    for (const h of many.values()) counts.set(h, (counts.get(h) ?? 0) + 1)
    expect([...counts.values()].every((n) => n === 2)).toBe(true)
  })
  it('the registry answers projectHue for known ids and falls back to the hash', () => {
    registerProjectHues(['a', 'b'])
    const m = assignProjectHues(['a', 'b'])
    expect(projectHue('b')).toBe(m.get('b'))
    expect(projectHue('unknown-id')).toBe(hashedHue('unknown-id'))
    registerProjectHues([])
  })
})

describe('projectHueVar', () => {
  it('maps hues to tokens and 0 to the neutral token', () => {
    expect(projectHueVar(1)).toBe('var(--project-1)')
    expect(projectHueVar(8)).toBe('var(--project-8)')
    expect(projectHueVar(0)).toBe('var(--text-tertiary)')
    expect(projectHueVar(9)).toBe('var(--text-tertiary)')
  })
})

describe('projectMonogram', () => {
  it('takes the first letters of the first two words', () => {
    expect(projectMonogram('Billing API')).toBe('BA')
    expect(projectMonogram('orgai')).toBe('O')
    expect(projectMonogram('acme-website redesign')).toBe('AW')
    expect(projectMonogram('myProject')).toBe('MP')
  })

  it('ignores a parenthetical suffix', () => {
    expect(projectMonogram('E2E dash busy (orgai test)')).toBe('ED')
  })

  it('handles non-Latin letters, digits and empty names', () => {
    expect(projectMonogram('école ouverte')).toBe('ÉO')
    expect(projectMonogram('2026 plan')).toBe('2P')
    expect(projectMonogram('')).toBe('?')
    expect(projectMonogram('!!!')).toBe('?')
    expect(projectMonogram(undefined)).toBe('?')
  })
})
