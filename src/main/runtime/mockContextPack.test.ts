import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, type MockScript, type MockSession } from './mock'
import { fakeCtx, project, runSummary } from './testHelpers'
import { CONTEXT_PACK_HEADING } from './contextPack'
import { WAITING_NOTE } from './waitingNote'
import type { RuntimeContext } from './types'

// The mock supports spawn `files` (split-execution 3.2) and the waiting note (3.6) the way Codex spawn_report does.

describe('mock spawn: context pack and waiting note', () => {
  let dir = ''
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-pack-')))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'contract.ts'), 'export type Id = string\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function run(work: MockScript['work'], over: Partial<RuntimeContext> = {}) {
    const ctx = fakeCtx({ project: project({ path: dir }), autoContinue: false, ...over })
    const session = (await new MockAdapter({ script: { delayMs: 0, work } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text === 'End.')).toBe(true))
    await session.stop()
    await session.finished
    return { ctx, session }
  }

  it('inlines the files into the report\'s first message and notes what was inlined and left out', async () => {
    const { session } = await run([
      { type: 'spawn', id: 'r1', role: 'engineer', description: 'Build', files: ['src/contract.ts', '/etc/hosts'] },
      { type: 'finish', id: 'r1', result: 'ok' },
      { type: 'text', text: 'End.' }
    ])
    const first = session.deliveredMessages.find((m) => m.agentId === 'r1')!.text
    expect(first).toContain(`${CONTEXT_PACK_HEADING}\n\nFile: src/contract.ts\n\`\`\`\nexport type Id = string\n\`\`\``)
    const notes = session.spawnNotes.map((n) => n.text)
    expect(notes[0]).toContain('Inlined 1 file into its brief: src/contract.ts.')
    expect(notes[0]).toContain('/etc/hosts (outside the folders the report may read)')
  })

  it('without files nothing is added, and a trust-restricted run gets no pack', async () => {
    const plain = await run([{ type: 'spawn', id: 'r1', role: 'engineer', description: 'Build' }, { type: 'finish', id: 'r1', result: 'ok' }, { type: 'text', text: 'End.' }])
    expect(plain.session.deliveredMessages.find((m) => m.agentId === 'r1')!.text).not.toContain(CONTEXT_PACK_HEADING)
    expect(plain.session.spawnNotes).toEqual([])
    const restricted = await run(
      [{ type: 'spawn', id: 'r1', role: 'engineer', description: 'Build', files: ['src/contract.ts'] }, { type: 'finish', id: 'r1', result: 'ok' }, { type: 'text', text: 'End.' }],
      { run: runSummary({ buildWorkspace: dir }) }
    )
    expect(restricted.session.deliveredMessages.find((m) => m.agentId === 'r1')!.text).not.toContain(CONTEXT_PACK_HEADING)
    expect(restricted.session.spawnNotes[0]!.text).toContain('not trusted')
  })

  it('gives the waiting note once when the root hands out one piece of a plan and does nothing itself', async () => {
    const { session, ctx } = await run([
      { type: 'plan', goal: 'Ship', steps: ['Module A', 'Module B'] },
      { type: 'spawn', id: 'r1', role: 'engineer', description: 'Module A' },
      { type: 'spawn', id: 'r2', role: 'reviewer', description: 'Module B' },
      { type: 'finish', id: 'r1', result: 'ok' },
      { type: 'finish', id: 'r2', result: 'ok' },
      { type: 'text', text: 'End.' }
    ])
    expect(session.spawnNotes).toEqual([{ agentId: 'root', reportId: 'r1', text: WAITING_NOTE }])
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.source === 'harness' && e.entry.block.kind === 'system' && e.entry.block.text === WAITING_NOTE)).toBe(true)
  })

  it("the root's prompt asks for files only where a pack can be inlined (contextPackRefusal)", async () => {
    const clause = 'pass the files you read as files'
    const plain = await run([{ type: 'text', text: 'End.' }])
    const root = plain.ctx.roles.find((r) => r.reportsTo === null)!
    expect(plain.session.rolePromptFor(root)).toContain(clause)
    const restricted = await run([{ type: 'text', text: 'End.' }], { run: runSummary({ buildWorkspace: dir }) })
    expect(restricted.session.rolePromptFor(root)).not.toContain(clause)
  })
})
