import { describe, expect, it } from 'vitest'
import { DelegationLedger } from './delegationLedger'

const make = (): DelegationLedger => {
  const l = new DelegationLedger({ obligations: { mgr: ['pol', 'evi'] }, strict: false }, { handle: (id) => id })
  l.noteRoot('root', 'lead')
  l.noteSpawn('m1', 'root', 'mgr')
  return l
}
const full = { canCorrect: true, canWait: true }

describe('DelegationLedger', () => {
  it('spawn -> correct -> spawn -> deliver -> allow', () => {
    const l = make()
    const first = l.completion('m1', { ...full, reportText: 'done' })
    expect(first.action).toBe('correct')
    expect(first.text).toContain('`pol` never spawned')
    expect(l.snapshot().agents.m1).toMatchObject({ phase: 'correcting', corrections: 1 })

    l.noteSpawn('p1', 'm1', 'pol')
    l.noteSpawn('e1', 'm1', 'evi')
    expect(l.snapshot().agents.m1.phase).toBe('working')
    expect(l.completion('p1', { ...full, reportText: 'policy report' })).toEqual({ action: 'allow', verdict: 'adaptive' })
    expect(l.completion('e1', { ...full, reportText: 'evidence report' }).action).toBe('allow')
    // not delivered yet: the manager must not pass
    expect(l.completion('m1', { canCorrect: true, canWait: false, reportText: 'x' }).action).toBe('fail')
  })

  it('allows once the reports are delivered', () => {
    const l = make()
    l.noteSpawn('p1', 'm1', 'pol')
    l.noteSpawn('e1', 'm1', 'evi')
    expect(l.completion('m1', { ...full, reportText: 'x' }).action).toBe('wait')
    l.completion('p1', { ...full, reportText: 'policy report' })
    l.completion('e1', { ...full, reportText: 'evidence report' })
    l.delivered('p1')
    l.delivered('e1')
    const r = l.completion('m1', { ...full, reportText: 'final' })
    expect(r).toEqual({ action: 'allow', verdict: 'ok' })
    expect(l.snapshot().receipts.find((x) => x.childId === 'm1')).toMatchObject({ parentId: 'root', verdict: 'ok', delivered: false, reportChars: 5 })
    // done agents return their record unchanged
    expect(l.completion('m1', { ...full, reportText: 'again' })).toEqual({ action: 'allow', verdict: 'ok' })
    expect(l.snapshot().receipts.filter((x) => x.childId === 'm1')).toHaveLength(1)
    expect(l.receiptText('m1')).toContain('required pol ✔ p1, evi ✔ e1')
  })

  it('skip twice -> fail, with a failure line and a summary', () => {
    const l = make()
    expect(l.completion('m1', { ...full, reportText: 'a' }).action).toBe('correct')
    const second = l.completion('m1', { ...full, reportText: 'b' })
    expect(second).toEqual({ action: 'fail', verdict: 'failed' })
    expect(l.snapshot().agents.m1.corrections).toBe(1)
    expect(l.receiptText('m1')).toMatch(/^Harness: m1 \(mgr\) FAILED its required delegation: pol never spawned, evi never spawned\./)
    const { summary, agents } = l.summary()
    expect(summary).toMatchObject({ failed: 1, corrected: 1, nativeSpawns: 0 })
    expect(agents.m1).toMatchObject({ verdict: 'failed', corrected: true })
    expect(agents.m1.missing).toEqual(['pol: never spawned', 'evi: never spawned'])
  })

  it('canCorrect false fails immediately; ended agents are ignored', () => {
    const l = make()
    expect(l.completion('m1', { canCorrect: false, canWait: false, reportText: 'x' }).action).toBe('fail')
    l.noteSpawn('m2', 'root', 'mgr')
    l.ended('m2')
    expect(l.completion('m2', { ...full, reportText: 'x' })).toEqual({ action: 'none' })
    expect(l.summary().summary.subtreeFailed).toBe(true)
  })

  it('records the root verdict and native strikes; roles without obligations are adaptive', () => {
    const l = make()
    l.noteSpawn('p1', 'm1', 'pol')
    expect(l.nativeStrike('p1')).toBe(1)
    expect(l.nativeStrike('p1')).toBe(2)
    expect(l.completion('p1', { ...full, reportText: 'x' }).verdict).toBe('adaptive')
    expect(l.completion('root', { ...full, reportText: 'x' }).verdict).toBe('adaptive')
    expect(l.summary()).toMatchObject({ summary: { nativeSpawns: 2, rootVerdict: 'adaptive' }, agents: { p1: { nativeSpawns: 2 } } })
    expect(l.receiptText('p1')).toBeUndefined()
  })

  it('round-trips through structuredClone', () => {
    const l = make()
    l.completion('m1', { ...full, reportText: 'a' })
    l.noteSpawn('p1', 'm1', 'pol')
    l.completion('p1', { ...full, reportText: 'r' })
    l.delivered('p1')
    const snap = structuredClone(l.snapshot())
    const back = new DelegationLedger({ state: snap })
    expect(back.snapshot()).toEqual(l.snapshot())
    expect(back.snapshot().agents.m1.corrections).toBe(1)
    expect(back.completion('m1', { canCorrect: true, canWait: false, reportText: 'z' }).action).toBe('fail')
    expect(() => structuredClone(l.summary())).not.toThrow()
  })
})
