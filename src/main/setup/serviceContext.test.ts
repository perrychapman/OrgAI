import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '@shared/types'
import { architectPrompt } from '@shared/setup'
import { ProjectStore } from '../store/projects'
import { project, role, runSummary } from '../runtime/testHelpers'
import { SetupService } from './service'

describe('Architect context', () => {
  let dir: string
  let service: SetupService
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-setupctx-'))
    mkdirSync(join(dir, 'repo'))
    service = new SetupService(new ProjectStore(join(dir, 'data')))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const roles = [
    role({ id: 'a', slug: 'lead', name: 'Lead', model: 'gw/big', tier: 'deep' }),
    role({ id: 'b', slug: 'dev', name: 'Dev', model: 'gw/custom', reportsTo: 'a' }),
    role({ id: 'c', slug: 'scribe', name: 'Scribe', model: 'inherit', reportsTo: 'a' }),
    role({ id: 'd', slug: 'qa', name: 'QA <b>', model: 'inherit', tier: 'fast', reportsTo: 'a' })
  ]

  it('hiddenContext lists name, slug, model with tier, and says unmentioned roles are kept', () => {
    const text = service.hiddenContext(project({ path: join(dir, 'repo'), roles }))
    expect(text).toContain('roles you do not mention in a revision are kept unchanged')
    expect(text).toContain('Lead (lead) [tier deep: gw/big] -> root')
    expect(text).toContain('Dev (dev) [model gw/custom] -> Lead')
    expect(text).toContain('Scribe (scribe) [inherit] -> Lead')
    expect(text).toContain('QA ‹b› (qa) [tier fast: inherit] -> Lead')
  })

  it('retroContext names the chart roles that did not take part in the run', () => {
    const agent = (id: string, roleSlug: string) => ({ id, name: roleSlug, roleSlug, parentId: id === 'x1' ? null : 'x1', state: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0 })
    const record = {
      summary: runSummary({ endedAt: 60000 }),
      agents: { x1: agent('x1', 'lead'), x2: agent('x2', 'dev') },
      logs: [],
      transcript: []
    } as unknown as RunRecord
    const text = service.retroContext(record, { roles })
    expect(text).toContain('Roles in the chart that did not take part in this run (not needed for this task; keep them unless there is other evidence): Scribe (scribe), QA ‹b› (qa)')
    expect(service.retroContext(record)).not.toContain('did not take part')
    expect(service.retroContext(record, { roles: roles.slice(0, 2) })).not.toContain('did not take part')
  })

  it('the Architect prompts no longer call unused roles a finding and mention remove', () => {
    for (const text of [architectPrompt('code'), architectPrompt('engagement')]) {
      expect(text).not.toContain('roles that were never used')
      expect(text).toContain('pass its slug in remove')
      expect(text).toContain('not evidence it is unneeded')
      expect(text).toContain('omit model to keep a role')
    }
  })
})
