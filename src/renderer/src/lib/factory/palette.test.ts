import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FACTORY_PALETTE, contrastRatio, lampFor, relativeLuminance } from './palette'

const THEMES = ['dark', 'light'] as const
const HEX = /^#[0-9a-f]{6}$/

/** --surface-0 of each theme block in tokens.css (the clear colour must match it). */
function surface0(theme: 'dark' | 'light'): string {
  const css = readFileSync(resolve(__dirname, '..', '..', 'styles', 'tokens.css'), 'utf8')
  const start = css.indexOf(theme === 'dark' ? ":root[data-theme='dark']" : ":root[data-theme='light'] {")
  const m = /--surface-0:\s*(#[0-9a-fA-F]{6})/.exec(css.slice(start))
  if (!m) throw new Error('--surface-0 not found')
  return m[1].toLowerCase()
}

// Minimum luminance contrast an object must have against the floor (not WCAG text contrast: a separation floor so a
// block never melts into the floor at far zoom). 1.3:1 is the floor; the robot, the focus of the scene, needs 3:1.
const SEPARATION = 1.3
const ROBOT = 3

describe('FACTORY_PALETTE', () => {
  for (const theme of THEMES) {
    const p = FACTORY_PALETTE[theme]
    const r = p.roles

    it(`${theme}: every colour is a lower-case #rrggbb hex`, () => {
      const all = [p.clear, p.gridFaint, p.gridStrong, p.lampOff, p.light.sky, p.light.ground, p.light.key, ...Object.values(r)]
      for (const c of all) expect(c).toMatch(HEX)
    })

    it(`${theme}: the clear colour is the app's --surface-0 and the floor does not blend into it`, () => {
      expect(p.clear).toBe(surface0(theme))
      expect(contrastRatio(p.clear, r.floor)).toBeGreaterThanOrEqual(SEPARATION)
    })

    it(`${theme}: robot body against the floor is at least ${ROBOT}:1`, () => {
      expect(contrastRatio(r.robotBody, r.floor)).toBeGreaterThanOrEqual(ROBOT)
      // And against the plate it stands beside, and the machine behind it.
      expect(contrastRatio(r.robotBody, r.plate)).toBeGreaterThanOrEqual(ROBOT)
      expect(contrastRatio(r.robotBody, r.machine)).toBeGreaterThanOrEqual(ROBOT)
      // The visor reads against the head it sits in.
      expect(contrastRatio(r.robotVisor, r.robotBody)).toBeGreaterThanOrEqual(2)
    })

    it(`${theme}: the far-LOD robot (unlit capsule) is at least ${ROBOT}:1 against the floor, plate and machine, also with the floor lit up to twice`, () => {
      expect(contrastRatio(r.robotFar, r.floor)).toBeGreaterThanOrEqual(ROBOT)
      expect(contrastRatio(r.robotFar, r.plate)).toBeGreaterThanOrEqual(ROBOT)
      expect(contrastRatio(r.robotFar, r.machine)).toBeGreaterThanOrEqual(ROBOT)
      // The unlit capsule keeps its colour; the lit floor can read up to twice its nominal linear luminance.
      const robot = relativeLuminance(r.robotFar)
      const floorLit = Math.min(1, relativeLuminance(r.floor) * 2)
      expect((Math.max(robot, floorLit) + 0.05) / (Math.min(robot, floorLit) + 0.05)).toBeGreaterThanOrEqual(ROBOT)
      // And the near robot body, which is lit, stays in the same family (not the opposite extreme).
      expect(Math.sign(relativeLuminance(r.robotFar) - relativeLuminance(r.floor))).toBe(Math.sign(relativeLuminance(r.robotBody) - relativeLuminance(r.floor)))
    })

    it(`${theme}: the crate is separable from the floor and the plate`, () => {
      expect(contrastRatio(r.crate, r.floor)).toBeGreaterThanOrEqual(1.5)
      expect(contrastRatio(r.crate, r.plate)).toBeGreaterThanOrEqual(1.3)
    })

    it(`${theme}: hall, deck, booth, plate and machine are each separable from the floor (${SEPARATION}:1)`, () => {
      for (const role of ['wall', 'deck', 'booth', 'plate', 'machine', 'console', 'dock', 'belt'] as const) {
        expect(contrastRatio(r[role], r.floor), role).toBeGreaterThanOrEqual(SEPARATION)
      }
    })

    it(`${theme}: stacked objects separate from what they stand on`, () => {
      expect(contrastRatio(r.booth, r.deck)).toBeGreaterThanOrEqual(SEPARATION)
      expect(contrastRatio(r.machine, r.plate)).toBeGreaterThanOrEqual(SEPARATION)
      expect(contrastRatio(r.console, r.plate)).toBeGreaterThanOrEqual(SEPARATION)
      expect(contrastRatio(r.deckEdge, r.deck)).toBeGreaterThanOrEqual(SEPARATION)
      expect(contrastRatio(r.dock, r.deck)).toBeGreaterThanOrEqual(1.15)
    })

    it(`${theme}: the grid stays faint on the floor and an off lamp reads against its housing`, () => {
      expect(contrastRatio(p.gridFaint, r.floor)).toBeLessThan(1.3)
      expect(contrastRatio(p.gridStrong, r.floor)).toBeLessThan(1.5)
      expect(contrastRatio(p.gridStrong, r.floor)).toBeGreaterThan(1.04)
      expect(contrastRatio(p.lampOff, r.pole)).toBeGreaterThanOrEqual(1.5)
    })

    it(`${theme}: floor paint is yellow and not any status token hue`, () => {
      const n = parseInt(r.paint.slice(1), 16)
      const red = (n >> 16) & 255
      const green = (n >> 8) & 255
      const blue = n & 255
      expect(red).toBeGreaterThan(blue + 60)
      expect(green).toBeGreaterThan(blue + 40)
    })
  }

  it('dark is dark and light is light (the themes are not one palette inverted)', () => {
    expect(relativeLuminance(FACTORY_PALETTE.dark.roles.floor)).toBeLessThan(0.05)
    expect(relativeLuminance(FACTORY_PALETTE.light.roles.floor)).toBeGreaterThan(0.5)
    // Light robots are dark bodies; dark robots are light bodies.
    expect(relativeLuminance(FACTORY_PALETTE.light.roles.robotBody)).toBeLessThan(0.1)
    expect(relativeLuminance(FACTORY_PALETTE.dark.roles.robotBody)).toBeGreaterThan(0.5)
  })

  it('dims the hall further when ended than when paused', () => {
    for (const theme of THEMES) {
      const l = FACTORY_PALETTE[theme].light
      expect(l.dimEnded).toBeLessThanOrEqual(l.dimPaused)
      expect(l.dimPaused).toBeLessThan(1)
    }
  })
})

describe('lampFor', () => {
  it('maps agent states to the three lamps (section 1.4)', () => {
    expect(lampFor('starting')).toBe('running')
    expect(lampFor('thinking')).toBe('running')
    expect(lampFor('tool')).toBe('running')
    expect(lampFor('delegating')).toBe('running')
    expect(lampFor('waiting')).toBe('needs-you')
    expect(lampFor('error')).toBe('failed')
    expect(lampFor('idle')).toBe('off')
    expect(lampFor('done')).toBe('off')
    expect(lampFor('role')).toBe('off')
  })
})
