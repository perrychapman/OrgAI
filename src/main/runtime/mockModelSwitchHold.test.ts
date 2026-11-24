import { describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'
import { MODEL_SWITCH_HOLD_TOKEN, MODEL_SWITCH_TOKEN, MockAdapter, type MockSession } from './mock'
import { fakeCtx } from './testHelpers'

const statuses = (events: RunEvent[]): string[] => events.flatMap((e) => (e.type === 'run.status' ? [e.status] : []))

async function idleSession(prompt: string) {
  const ctx = fakeCtx({ prompt, autoContinue: false })
  const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
  await vi.waitFor(() => expect(statuses(ctx.events).at(-1)).toBe('idle'))
  return { ctx, session }
}

describe('mock [mock:model-switch-hold]', () => {
  it('keeps the turn running after its reply until the interrupt, so "Interrupt and switch" is pressed on a running run at any speed', async () => {
    const { ctx, session } = await idleSession(MODEL_SWITCH_TOKEN)
    const reply = `A long reply ${MODEL_SWITCH_HOLD_TOKEN}`
    await session.send(reply)
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text.endsWith(reply))).toBe(true))
    // Long against a mock delay of 0: an unheld turn is idle already.
    await new Promise((r) => setTimeout(r, 300))
    expect(statuses(ctx.events).at(-1)).toBe('running')
    await session.interrupt()
    await vi.waitFor(() => expect(statuses(ctx.events).at(-1)).toBe('idle'))
    // Idle again, and a later message is answered as before.
    await session.send('Verify')
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text.endsWith('): Verify'))).toBe(true))
    await vi.waitFor(() => expect(statuses(ctx.events).at(-1)).toBe('idle'))
    await session.stop()
    await session.finished
  })

  it('stop releases the hold', async () => {
    const { ctx, session } = await idleSession(MODEL_SWITCH_TOKEN)
    await session.send(`Hold ${MODEL_SWITCH_HOLD_TOKEN}`)
    await vi.waitFor(() => expect(statuses(ctx.events).at(-1)).toBe('running'))
    await session.stop()
    await session.finished
    expect(statuses(ctx.events).at(-1)).toBe('finished')
  })

  it('without the token, or on a run without the model-switch marker, the reply ends the turn as before', async () => {
    const plain = await idleSession(MODEL_SWITCH_TOKEN)
    await plain.session.send('No hold')
    await vi.waitFor(() => expect(plain.ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text.endsWith('): No hold'))).toBe(true))
    await vi.waitFor(() => expect(statuses(plain.ctx.events).at(-1)).toBe('idle'))
    await plain.session.stop()
    await plain.session.finished

    const unmarked = await idleSession('Hello')
    await unmarked.session.send(`Ignored ${MODEL_SWITCH_HOLD_TOKEN}`)
    await vi.waitFor(() => expect(statuses(unmarked.ctx.events).at(-1)).toBe('idle'))
    await new Promise((r) => setTimeout(r, 100))
    expect(statuses(unmarked.ctx.events).at(-1)).toBe('idle')
    await unmarked.session.stop()
    await unmarked.session.finished
  })
})
