import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '../../shared/types'
import { trayHeight } from './trayLayout'
import { cardKey, type CardRef, type TrayCard } from './types'

function card(id: string, command: string): TrayCard {
  const ref: CardRef = { hostInstanceId: 'h', runId: 'r', requestId: id, kind: 'permission', revision: 1 }
  const req: PermissionRequest = { id, runId: 'r', agentId: 'root', toolName: 'Bash', input: { command }, summary: 'Run', suggestions: [], ruleLabels: [] }
  return { key: cardKey(ref), ref, runTag: 'R1', runKind: 'work', arrivedSeq: 1, kind: 'permission', card: req } as TrayCard
}

describe('trayHeight', () => {
  it('no cards: 1 row full, 0 inline; inline with cards is 3', () => {
    expect(trayHeight([], 100, 40, false)).toBe(1)
    expect(trayHeight([], 100, 40, true)).toBe(0)
    expect(trayHeight([card('a', 'ls')], 100, 40, true)).toBe(3)
  })

  it('at least 5, even for a one-line card', () => {
    expect(trayHeight([card('a', 'ls')], 120, 40, false)).toBeGreaterThanOrEqual(5)
  })

  it('a long card hits the cap: 35% of the rows, at most 12, at least 5', () => {
    const long = card('a', Array.from({ length: 80 }, (_, i) => `echo ${i}`).join(' && '))
    expect(trayHeight([long], 120, 40, false)).toBe(12)
    expect(trayHeight([long], 100, 30, false)).toBe(10)
    expect(trayHeight([long], 80, 24, false)).toBe(8)
    expect(trayHeight([long], 80, 10, false)).toBe(5)
  })

  it('counts wrapped hint rows (narrower is taller) and the queue', () => {
    const one = [card('a', 'ls')]
    expect(trayHeight(one, 40, 80, false)).toBeGreaterThan(trayHeight(one, 200, 80, false))
    const queued = [card('a', 'ls'), card('b', 'ls'), card('c', 'ls')]
    expect(trayHeight(queued, 120, 80, false)).toBeGreaterThan(trayHeight(one, 120, 80, false))
  })
})
