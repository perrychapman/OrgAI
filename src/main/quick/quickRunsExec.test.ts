import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunSummary } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { QuickRunService } from './quickRuns'

let dir: string
let data: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-quick-exec-'))
  data = join(dir, 'data')
  mkdirSync(data, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service() {
  const start = vi.fn(async (input: { project: Project }) => ({ id: 'run_q', projectId: input.project.id }) as RunSummary)
  const svc = new QuickRunService({
    dataDir: data,
    settings: () => DEFAULT_APP_SETTINGS,
    runs: { start, summary: () => null, chain: () => [] },
    store: { all: () => [], moveToProject: () => [] },
    projects: { list: () => [], create: () => ({}) as Project },
    prepare: (p) => p,
    broadcast: () => {},
    mock: true
  })
  return { svc, start }
}

describe('QuickRunService.start overrides (cli-spec 6.2(1))', () => {
  it('passes overrides to runs.start with allowWidening false when nothing checks them', async () => {
    const { svc, start } = service()
    await svc.start({ prompt: 'hi', overrides: { permissionMode: 'plan', execMode: true } })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ overrides: { permissionMode: 'plan', execMode: true }, allowWidening: false }))
  })

  it("asks checkOverrides with the quick project (mode 'default') and passes its answer as allowWidening", async () => {
    const { svc, start } = service()
    const seen: Project[] = []
    await svc.start({ prompt: 'hi', overrides: { maxBudgetUsd: 1 } }, { checkOverrides: (p) => (seen.push(p), true) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 'quick', permissionMode: 'default' })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ project: seen[0], overrides: { maxBudgetUsd: 1 }, allowWidening: true }))
  })

  it('a refusal from checkOverrides starts nothing and removes the scratch dir it made', async () => {
    const { svc, start } = service()
    const refuse = () => {
      throw new Error('These run options need the configure scope: permissionMode.')
    }
    await expect(svc.start({ prompt: 'hi', overrides: { permissionMode: 'bypassPermissions' } }, { checkOverrides: refuse })).rejects.toThrow(/configure scope/)
    expect(start).not.toHaveBeenCalled()
    const quickRoot = join(data, 'quick')
    expect(readdirSync(quickRoot).filter((n) => n.startsWith('quick_'))).toEqual([])
  })

  it('without overrides nothing is checked and the call has no override keys', async () => {
    const { svc, start } = service()
    const check = vi.fn(() => true)
    await svc.start({ prompt: 'hi' }, { checkOverrides: check })
    expect(check).not.toHaveBeenCalled()
    const arg = start.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(arg).not.toHaveProperty('overrides')
    expect(arg).not.toHaveProperty('allowWidening')
  })
})
