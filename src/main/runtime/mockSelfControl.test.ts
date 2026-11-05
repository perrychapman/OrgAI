import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PermissionMode, RunEvent } from '@shared/types'
import { MockAdapter, type MockSession } from './mock'
import { SELF_CONTROL_DENIAL_MESSAGE, SELF_CONTROL_REFUSAL_TEXT, SELF_CONTROL_UNCHECKED_MESSAGE, controlProtectedPaths } from './selfControlGate'
import { fakeCtx, project } from './testHelpers'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}

const results = (events: RunEvent[]) => events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [e.entry.block] : []))
const rows = (events: RunEvent[]) =>
  events.filter((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text === SELF_CONTROL_REFUSAL_TEXT && e.entry.source === 'harness')

describe('MockSession self-control gate', () => {
  for (const mode of ['bypassPermissions', 'acceptEdits'] as const satisfies readonly PermissionMode[]) {
    it(`refuses the orgai command and control files through the tool path under ${mode}`, async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-self-')))
      dirs.push(base)
      const repo = join(base, 'repo')
      const data = join(base, 'data')
      mkdirSync(repo)
      mkdirSync(join(data, 'run'), { recursive: true })
      const ctx = fakeCtx({
        project: project({ path: repo, permissionMode: mode }),
        autoContinue: false,
        allowedRules: () => ['Bash(*)', 'Read', 'Edit'],
        controlProtectedPaths: () => controlProtectedPaths(data)
      })
      const session = (await new MockAdapter({
        script: {
          delayMs: 0,
          work: [
            { type: 'tool', name: 'Bash', input: { command: 'orgai daemon stop' }, ask: true, result: 'stopped' },
            { type: 'tool', name: 'Read', input: { file_path: join(data, 'run', 'daemon.secret') }, result: 'secret' },
            { type: 'tool', name: 'Write', input: { file_path: join(data, 'secrets.json'), content: '{}' }, ask: true, result: 'written' },
            { type: 'tool', name: 'Bash', input: { command: 'npm test' }, result: 'tests ok' },
            { type: 'text', text: 'All done.' }
          ]
        }
      }).start(ctx)) as MockSession
      await waitFor(() => results(ctx.events).some((r) => r.content === 'tests ok'))
      await session.stop()
      await session.finished
      const out = results(ctx.events)
      const denied = out.filter((r) => r.content === SELF_CONTROL_DENIAL_MESSAGE)
      expect(denied).toHaveLength(3)
      expect(denied.every((r) => r.isError)).toBe(true)
      expect(out.some((r) => r.content === 'stopped' || r.content === 'secret' || r.content === 'written')).toBe(false)
      expect(out.find((r) => r.content === 'tests ok')?.isError).toBe(false)
      expect(rows(ctx.events)).toHaveLength(3)
      expect(ctx.requestPermission).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: 'Write' }))
      expect(ctx.requestPermission).not.toHaveBeenCalledWith(expect.objectContaining({ input: { command: 'orgai daemon stop' } }))
      expect(ctx.events.filter((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('OrgAI control files or the orgai command'))).toHaveLength(3)
    })
  }

  it('refuses shell commands unchecked when the protected paths are unavailable; file tools go on (review M2)', async () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-self-')))
    dirs.push(base)
    const repo = join(base, 'repo')
    mkdirSync(repo)
    const ctx = fakeCtx({
      project: project({ path: repo, permissionMode: 'bypassPermissions' }),
      autoContinue: false,
      allowedRules: () => ['Bash(*)', 'Read'],
      controlProtectedPaths: () => []
    })
    const session = (await new MockAdapter({
      script: {
        delayMs: 0,
        work: [
          { type: 'tool', name: 'Bash', input: { command: 'ls' }, result: 'listing' },
          { type: 'tool', name: 'Read', input: { file_path: join(repo, 'README.md') }, result: 'readme' },
          { type: 'text', text: 'All done.' }
        ]
      }
    }).start(ctx)) as MockSession
    await waitFor(() => results(ctx.events).some((r) => r.content === 'readme'))
    await session.stop()
    await session.finished
    const out = results(ctx.events)
    expect(out.find((r) => r.content === SELF_CONTROL_UNCHECKED_MESSAGE)?.isError).toBe(true)
    expect(out.some((r) => r.content === 'listing')).toBe(false)
    expect(out.find((r) => r.content === 'readme')?.isError).toBe(false)
    expect(ctx.events.filter((e) => e.type === 'log' && e.message.includes('control paths are unavailable'))).toHaveLength(1)
  })
})
