import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import { createEvolveService } from '../evolve/service'
import { project as makeProject, run } from '../evolve/fixtures'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-evolve-usage-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('hybrid analysis spend', () => {
  it('the completion result\'s usage is reported through onUsage and returned in plan.usage', async () => {
    let p: Project = makeProject()
    const runs = [0, 1, 2, 3].map((i) => run({ id: `r${i}`, agents: [{ slug: 'dev', conflict: i % 2 === 0, files: ['src/a/x.ts'] }, { slug: 'dev', files: ['src/a/y.ts'] }] }))
    const usage = { inputTokens: 1200, outputTokens: 300, costUsd: 0.004 }
    const complete = vi.fn(async () => ({ text: 'not json at all', usage }))
    const onUsage = vi.fn()
    const svc = createEvolveService({
      dataDir: dir,
      getProject: () => p,
      updateProject: (_id, fn) => (p = fn(p)),
      listRunRecords: () => runs,
      complete,
      onUsage
    })
    const res = await svc.analyze({ projectId: p.id, strategy: 'hybrid', minWaste: 0 })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith(usage)
    expect(res.plan.usage).toEqual(usage)
  })
})
