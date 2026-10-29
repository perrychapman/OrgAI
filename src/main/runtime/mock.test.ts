import { describe, expect, it } from 'vitest'
import type { ImageAttachment, McpServerSpec, RunEvent, TranscriptBlock } from '@shared/types'
import { MockAdapter, type MockSession } from './mock'
import { ROOT_AGENT_ID } from './types'
import { fakeCtx, project, runSummary } from './testHelpers'

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

describe('mock adapter MCP and connection recording', () => {
  const spec = (id: string, name: string, over: Partial<McpServerSpec> = {}): McpServerSpec => ({
    id,
    name,
    transport: 'stdio',
    command: 'npx',
    enabled: true,
    source: 'user',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over
  })

  it('records per-role MCP servers, enabled plugins and the connection without secrets', async () => {
    const p = project({ mcpServers: [spec('m1', 'fs', { roles: ['lead'] }), spec('m2', 'web')] })
    const ctx = fakeCtx({
      project: p,
      mcpServers: () => p.mcpServers ?? [],
      plugins: () => [
        { id: 'a', name: 'a', path: '/p/a', enabled: true },
        { id: 'b', name: 'b', path: '/p/b', enabled: false }
      ],
      connection: { connection: 'litellm', adapter: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'secret' } }
    })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await session.stop()
    await session.finished
    expect(session.mcpServersByRole).toEqual({ lead: ['fs', 'web'], engineer: ['web'], reviewer: ['web'] })
    expect(session.plugins.map((x) => x.id)).toEqual(['a'])
    expect(session.connection).toEqual({ adapter: 'claude', connection: 'litellm' })
    expect(JSON.stringify(session.connection)).not.toContain('secret')
  })

  it('records servers attached through the addMcpServer hook', async () => {
    const ctx = fakeCtx()
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    const added = spec('m9', 'late')
    await expect(session.addMcpServer(added)).resolves.toBe('mcp__late__')
    expect(session.addedMcpServers).toEqual([added])
    await session.stop()
    await session.finished
  })

  it('runs the mcp-assist script with the assistant tools and never nudges', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'mcp-assist' }), autoContinue: true, continuationDelayMs: 1 })
    const session = (await new MockAdapter({
      script: { delayMs: 0, mcpAssist: [{ type: 'harness', name: 'ask_user', args: { question: 'Which server?', options: [{ label: 'fs' }, { label: 'web' }] } }] }
    }).start(ctx)) as MockSession
    for (let i = 0; i < 100 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 30))
    await session.stop()
    await session.finished
    expect(ctx.requestQuestion).toHaveBeenCalled()
    expect(session.harnessMessages).toEqual([])
    expect(ctx.events.some((e) => e.type === 'log' && /unknown harness tool/.test(e.message))).toBe(false)
  })
})
