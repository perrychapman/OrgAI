import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { READ_DOCUMENT_TOOL, type TranscriptBlock } from '@shared/types'

const seen = vi.hoisted(() => ({ calls: [] as { args: unknown; caller: unknown }[], offered: true }))
// The real read_document definition lands separately in harnessTools; until then the mock is given a recording stand-in.
vi.mock('./harnessTools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./harnessTools')>()
  return {
    ...orig,
    harnessToolsFor: (...args: Parameters<typeof orig.harnessToolsFor>) => {
      const tools = orig.harnessToolsFor(...args).filter((t) => t.name !== READ_DOCUMENT_TOOL)
      if (!seen.offered) return tools
      return [
        ...tools,
        {
          name: READ_DOCUMENT_TOOL,
          description: 'stub',
          audience: 'all' as const,
          inputSchema: z.object({ path: z.string() }),
          call: async (args: unknown, caller: unknown) => {
            seen.calls.push({ args, caller })
            return 'Sheet 1 of 1\nA1: hello'
          }
        }
      ]
    }
  }
})

import { MOCK_READ_NONE, MockAdapter, readMarkerSteps, type MockSession } from './mock'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'
import { fakeCtx, project, runSummary } from './testHelpers'

const quick = { folder: '/some/folder', team: 'single' as const, allowEdits: false, gitRepo: false }
const blocks = (ctx: ReturnType<typeof fakeCtx>): TranscriptBlock[] => ctx.events.flatMap((e) => (e.type === 'transcript' ? [e.entry.block] : []))
const texts = (ctx: ReturnType<typeof fakeCtx>) => blocks(ctx).flatMap((b) => (b.kind === 'text' ? [b.text] : []))
async function runToIdle(ctx: ReturnType<typeof fakeCtx>): Promise<MockSession> {
  const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
  await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true), { timeout: 3000 })
  return session
}
const stopAll = async (s: MockSession): Promise<void> => {
  await s.stop()
  await s.finished
}
const make = (prompt: string, chat: boolean, over: Partial<RuntimeContext> = {}) =>
  fakeCtx({ run: chat ? runSummary({ projectId: 'quick', quick, prompt }) : runSummary({ prompt }), project: project({ path: '/the/project' }), prompt, autoContinue: false, ...over } as Partial<RuntimeContext>)

describe('readMarkerSteps', () => {
  it('parses the path between the marker and the closing bracket, and ignores other prompts', () => {
    expect(readMarkerSteps('please [mock:read docs/budget 2026.xlsx] now')).toMatchObject([{ type: 'harnessAnswer', name: READ_DOCUMENT_TOOL, args: { path: 'docs/budget 2026.xlsx' } }])
    expect(readMarkerSteps('no marker')).toBeNull()
    expect(readMarkerSteps('[mock:read ]')).toBeNull()
    expect(readMarkerSteps('[mock:read-nothing]')).toBeNull()
  })
})

describe('mock [mock:read <path>]', () => {
  it.each([[true], [false]])('chat=%s: calls read_document with { path } as the root with the project folder, and says the tool text', async (chat) => {
    seen.offered = true
    seen.calls.length = 0
    const ctx = make('[mock:read notes/plan.docx]', chat)
    const session = await runToIdle(ctx)
    expect(seen.calls).toHaveLength(1)
    expect(seen.calls[0]!.args).toEqual({ path: 'notes/plan.docx' })
    expect(seen.calls[0]!.caller).toMatchObject({ agentId: ROOT_AGENT_ID, cwd: '/the/project' })
    expect(blocks(ctx).find((b) => b.kind === 'tool_use' && b.name === READ_DOCUMENT_TOOL)).toMatchObject({ input: { path: 'notes/plan.docx' } })
    expect(texts(ctx)).toEqual(['Sheet 1 of 1\nA1: hello'])
    await stopAll(session)
  })

  it('without the tool the root says it is not available', async () => {
    seen.offered = false
    const ctx = make('[mock:read a.xlsx]', true)
    const session = await runToIdle(ctx)
    expect(texts(ctx)).toEqual([MOCK_READ_NONE])
    await stopAll(session)
    seen.offered = true
  })
})
