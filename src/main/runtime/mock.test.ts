import { describe, expect, it } from 'vitest'
import type { ImageAttachment, RunEvent, TranscriptBlock } from '@shared/types'
import { MockAdapter } from './mock'
import { ROOT_AGENT_ID } from './types'
import { fakeCtx } from './testHelpers'

const png: ImageAttachment = { mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }

function userBlocks(events: RunEvent[]): Extract<TranscriptBlock, { kind: 'user' }>[] {
  const out: Extract<TranscriptBlock, { kind: 'user' }>[] = []
  for (const e of events) if (e.type === 'transcript' && e.entry.block.kind === 'user' && e.entry.agentId === ROOT_AGENT_ID) out.push(e.entry.block)
  return out
}

describe('mock adapter image attachments', () => {
  it('records images on the first prompt and on send(), and omits the key when there are none', async () => {
    const ctx = fakeCtx({ prompt: 'Look at this', images: [png] })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await session.send('And this', [png, png])
    await session.send('No images')
    await session.stop()
    await session.finished

    const blocks = userBlocks(ctx.events)
    expect(blocks[0]).toEqual({ kind: 'user', text: 'Look at this', images: [png] })
    expect(blocks[1]).toEqual({ kind: 'user', text: 'And this', images: [png, png] })
    expect(blocks[2]).toEqual({ kind: 'user', text: 'No images' })
    expect('images' in blocks[2]).toBe(false)
  })

  it('treats an image-only send as a turn and replies', async () => {
    const ctx = fakeCtx({ prompt: 'Start' })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await session.send('', [png])
    await session.send('', [png, png])
    const texts: string[] = []
    const collect = (): void => {
      texts.length = 0
      for (const e of ctx.events) {
        if (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text') texts.push(e.entry.block.text)
      }
    }
    for (let i = 0; i < 200; i++) {
      collect()
      if (texts.includes('Mock reply to: [2 images]')) break
      await new Promise((r) => setTimeout(r, 10))
    }
    await session.stop()
    await session.finished
    expect(texts).toContain('Mock reply to: [1 image]')
    expect(texts).toContain('Mock reply to: [2 images]')
  })
})
