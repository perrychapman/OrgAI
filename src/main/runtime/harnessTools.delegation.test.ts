import { describe, expect, it } from 'vitest'
import type { RunPlan } from '@shared/types'
import { completePlan } from './harnessTools'
import { fakeCtx } from './testHelpers'
import type { DelegationCompletion, DelegationGate } from './types'

// complete_plan's provisional root check through ctx.delegation (spec 5.6).

function gate(answer: DelegationCompletion): DelegationGate & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    noteSpawn: () => {},
    completion: (id, opts) => {
      calls.push({ id, ...opts })
      return answer
    },
    ended: () => {},
    delivered: () => {},
    receiptText: () => undefined,
    nativeStrike: () => 0
  }
}

function setup(answer?: DelegationCompletion) {
  let plan: RunPlan | undefined = { goal: 'g', steps: [], status: 'active', autoContinues: 0, updatedAt: 0 }
  const g = answer ? gate(answer) : undefined
  const ctx = fakeCtx({ getPlan: () => plan, updatePlan: async (p: RunPlan) => void (plan = p), ...(g ? { delegation: g } : {}) })
  const call = (): Promise<string> => completePlan.handler(ctx, { summary: 'all done' }, {} as never, {}) as Promise<string>
  return { call, plan: () => plan, g }
}

describe('complete_plan with a delegation gate', () => {
  it('without a gate behaves as before', async () => {
    const s = setup()
    expect(await s.call()).toContain('Plan marked complete.')
    expect(s.plan()?.status).toBe('done')
  })

  it('allow completes the plan; the check is provisional with canWait true', async () => {
    const s = setup({ action: 'allow', verdict: 'ok' })
    expect(await s.call()).toContain('Plan marked complete.')
    expect(s.g?.calls[0]).toMatchObject({ id: 'root', canCorrect: true, canWait: true, provisional: true })
  })

  it('wait refuses: reports are still running, the plan stays active', async () => {
    const s = setup({ action: 'wait', text: 'Harness: wait for policy.' })
    expect(await s.call()).toMatch(/^REFUSED: reports are still running\./)
    expect(s.plan()?.status).toBe('active')
  })

  it('correct refuses with the correction text, the plan stays active', async () => {
    const s = setup({ action: 'correct', text: 'Harness: you cannot finish yet.' })
    const out = await s.call()
    expect(out).toMatch(/^REFUSED: Harness: you cannot finish yet\./)
    expect(s.plan()?.status).toBe('active')
  })

  it('fail is accepted and says the run is recorded as failing its required delegation', async () => {
    const s = setup({ action: 'fail', verdict: 'failed', missing: 'policy never spawned' })
    const out = await s.call()
    expect(out).toContain('Plan marked complete.')
    expect(out).toContain('recorded as failing its required delegation (policy never spawned)')
    expect(s.plan()?.status).toBe('done')
  })
})
