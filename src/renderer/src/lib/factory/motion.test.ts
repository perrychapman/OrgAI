import { describe, expect, it } from 'vitest'
import type { AgentState } from '@shared/types'
import { FACTORY_STATUS_WORD } from './agentView'
import { EMPTY_LAYOUT_MEMORY, layoutFloor } from './layout'
import { buildFloorModel } from './model'
import {
  AMBIENT_CAP,
  AMBIENT_PHASE_MS,
  CAPSULE_MAX_MS,
  CAPSULE_MIN_MS,
  CAPSULE_SPEED,
  FACTORY_CYCLE_MS,
  PART_MS,
  TOTE_MAX_MS,
  TOTE_MIN_MS,
  TOTE_SPEED,
  ambientSet,
  ambientWave,
  cueEase,
  travelMs
} from './motion'
import type { FactoryAgentInput } from './types'

function agent(id: string, parentId: string | null, startedAt: number, state: AgentState = 'thinking'): FactoryAgentInput {
  return { id, name: id, parentId, roleKey: 'r', handle: id, state, statusWord: FACTORY_STATUS_WORD[state], activity: '', toolCalls: 0, startedAt, session: 'current' }
}

function floorOf(input: FactoryAgentInput[], status?: 'paused' | 'finished') {
  const layout = layoutFloor({ runKey: 'r', agents: input }, EMPTY_LAYOUT_MEMORY).layout
  return buildFloorModel(input, layout, [], null, status)
}

describe('motion constants (section 5)', () => {
  it('keeps the spec numbers', () => {
    expect(FACTORY_CYCLE_MS).toBe(2800)
    expect(AMBIENT_CAP).toBe(12)
    expect(AMBIENT_PHASE_MS).toBe(150)
    expect(PART_MS).toBe(940)
  })
})

describe('travelMs', () => {
  it('distance over speed, clamped', () => {
    expect(travelMs(8, TOTE_SPEED, TOTE_MIN_MS, TOTE_MAX_MS)).toBe(1000)
    expect(travelMs(1, TOTE_SPEED, TOTE_MIN_MS, TOTE_MAX_MS)).toBe(600)
    expect(travelMs(100, TOTE_SPEED, TOTE_MIN_MS, TOTE_MAX_MS)).toBe(2000)
    expect(travelMs(12, CAPSULE_SPEED, CAPSULE_MIN_MS, CAPSULE_MAX_MS)).toBe(1200)
    expect(travelMs(-5, CAPSULE_SPEED, CAPSULE_MIN_MS, CAPSULE_MAX_MS)).toBe(500)
  })
})

describe('cueEase', () => {
  it('ends at 0 and 1 for every kind and clamps', () => {
    for (const k of ['arrive', 'leave', 'tote', 'capsule', 'part', 'crate', 'shutter', 'barrier', 'pose', 'hall'] as const) {
      expect(cueEase(k, 0)).toBe(0)
      expect(cueEase(k, 1)).toBe(1)
      expect(cueEase(k, -1)).toBe(0)
      expect(cueEase(k, 2)).toBe(1)
    }
  })
  it('ease-out for arrive, shutter, barrier; ease-in-out for carriers, crate, pose; linear for part, leave, hall', () => {
    expect(cueEase('arrive', 0.5)).toBe(0.75)
    expect(cueEase('shutter', 0.5)).toBe(0.75)
    expect(cueEase('barrier', 0.25)).toBeCloseTo(0.4375)
    expect(cueEase('tote', 0.25)).toBe(0.125)
    expect(cueEase('capsule', 0.5)).toBe(0.5)
    expect(cueEase('crate', 0.75)).toBe(0.875)
    expect(cueEase('pose', 0.25)).toBe(0.125)
    expect(cueEase('part', 0.3)).toBe(0.3)
    expect(cueEase('leave', 0.3)).toBe(0.3)
    expect(cueEase('hall', 0.3)).toBe(0.3)
  })
})

describe('ambientWave', () => {
  it('rests at 0, peaks at half a cycle, repeats every FACTORY_CYCLE_MS', () => {
    expect(ambientWave(0, 0)).toBeCloseTo(0)
    expect(ambientWave(1400, 0)).toBeCloseTo(1)
    expect(ambientWave(700, 0)).toBeCloseTo(0.5)
    expect(ambientWave(2800, 0)).toBeCloseTo(0)
    expect(ambientWave(5000, 0)).toBeCloseTo(ambientWave(2200, 0))
  })
  it('offsets each phase index by 150 ms, also before time 0', () => {
    expect(ambientWave(150, 1)).toBeCloseTo(0)
    expect(ambientWave(1400 + 300, 2)).toBeCloseTo(1)
    expect(ambientWave(0, 3)).toBeCloseTo(ambientWave(2800 - 450, 0))
    for (let t = 0; t < 3000; t += 97) {
      const v = ambientWave(t, 5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('ambientSet (section 5.1)', () => {
  // root + 20 benches: even ones in tool, odd ones thinking; b3 idle, b4 failed.
  const input: FactoryAgentInput[] = [agent('root', null, 0, 'delegating')]
  for (let i = 0; i < 20; i++) {
    const state: AgentState = i === 3 ? 'idle' : i === 4 ? 'error' : i % 2 === 0 ? 'tool' : 'thinking'
    input.push(agent(`b${i}`, 'root', i + 1, state))
  }
  const m = floorOf(input)
  const none = (): boolean => false

  it('caps at 12 in layout order, phases 0 to 11, kinds from the model', () => {
    const s = ambientSet(m, none)
    expect(s.size).toBe(AMBIENT_CAP)
    const ids = [...s.keys()]
    expect(ids[0]).toBe('root')
    expect(ids).not.toContain('b3')
    expect(ids).not.toContain('b4')
    expect(ids).toEqual(['root', 'b0', 'b1', 'b2', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12'])
    expect([...s.values()].map((v) => v.phase)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(s.get('root')?.kind).toBe('screen')
    expect(s.get('b0')?.kind).toBe('machine')
    expect(s.get('b1')?.kind).toBe('screen')
  })

  it('priority: selected first, then on-screen in layout order, then the rest', () => {
    const onScreen = (id: string): boolean => id === 'b19' || id === 'b17' || id === 'b3'
    const s = ambientSet(m, onScreen, 'b18')
    const ids = [...s.keys()]
    expect(ids.slice(0, 3)).toEqual(['b18', 'b17', 'b19'])
    expect(ids.slice(3, 6)).toEqual(['root', 'b0', 'b1'])
    expect(s.size).toBe(12)
    expect(s.get('b18')?.phase).toBe(0)
    expect(s.get('b19')?.phase).toBe(2)
  })

  it('a selected worker that does not loop takes no place', () => {
    const s = ambientSet(m, none, 'b3')
    expect(s.has('b3')).toBe(false)
    expect([...s.keys()][0]).toBe('root')
    expect(ambientSet(m, none, 'nobody').size).toBe(12)
  })

  it('empty when the hall is paused or ended, and in team mode', () => {
    expect(ambientSet(floorOf(input, 'paused'), none).size).toBe(0)
    expect(ambientSet(floorOf(input, 'finished'), none).size).toBe(0)
    expect(ambientSet({ ...m, mode: 'team' }, none).size).toBe(0)
    // a hand-built model with ambient set but hall off still gives nothing
    expect(ambientSet({ ...m, hall: 'paused' }, none).size).toBe(0)
  })

  it('fewer candidates than the cap: all of them', () => {
    const small = floorOf([agent('root', null, 0, 'idle'), agent('a', 'root', 1, 'tool'), agent('b', 'root', 2, 'done')])
    expect([...ambientSet(small, none).entries()]).toEqual([['a', { kind: 'machine', phase: 0 }]])
  })
})
