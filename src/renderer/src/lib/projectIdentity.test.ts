import { describe, expect, it } from 'vitest'
import { PROJECT_HUES, projectHue, projectHueVar, projectMonogram } from './projectIdentity'

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
