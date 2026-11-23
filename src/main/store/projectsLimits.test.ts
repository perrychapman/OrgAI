import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Role } from '@shared/types'
import { PROJECT_MAX_AGENTS_PER_RUN_LIMIT, PROJECT_TEST_COMMAND_MAX_CHARS, ROLE_MAX_CONCURRENT_LIMIT } from '@shared/types'
import { project, role as makeRole } from '../runtime/testHelpers'
import { ProjectStore, cleanMainBranch, cleanProjectLimits, cleanRoleLimits, cleanTestCommand } from './projects'

const dirs: string[] = []
function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-projects-limits-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const role = (): Role => makeRole({ id: 'r-lead', slug: 'lead' })
const asProject = (extra: Record<string, unknown>): Project => ({ ...project(), ...extra }) as Project

describe('cleanProjectLimits', () => {
  it('keeps valid values untouched (same object back)', () => {
    const p = asProject({
      maxDailyUsd: 5,
      maxMonthlyUsd: 100.5,
      onSpendLimit: 'stop',
      maxAgentsPerRun: 12,
      schedulesNearPlanLimit: true,
      mainBranch: 'release/1.x',
      requireTestsPass: true,
      testCommand: 'npm test',
      keepFailedBranchesDays: 30
    })
    expect(cleanProjectLimits(p)).toBe(p)
  })

  it('drops caps that are not finite and positive', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, true]) {
      const out = cleanProjectLimits(asProject({ maxDailyUsd: bad, maxMonthlyUsd: bad })) as unknown as Record<string, unknown>
      expect(Object.hasOwn(out, 'maxDailyUsd')).toBe(false)
      expect(Object.hasOwn(out, 'maxMonthlyUsd')).toBe(false)
    }
  })

  it("keeps onSpendLimit only as 'pause' or 'stop'", () => {
    expect(cleanProjectLimits(asProject({ onSpendLimit: 'pause' })).onSpendLimit).toBe('pause')
    for (const bad of ['Stop', 'resume', '', 1, null]) expect(cleanProjectLimits(asProject({ onSpendLimit: bad })).onSpendLimit).toBeUndefined()
  })

  it('keeps integers in range for maxAgentsPerRun and keepFailedBranchesDays, drops the rest without rounding', () => {
    expect(cleanProjectLimits(asProject({ maxAgentsPerRun: 1, keepFailedBranchesDays: 1 }))).toMatchObject({ maxAgentsPerRun: 1, keepFailedBranchesDays: 1 })
    expect(cleanProjectLimits(asProject({ maxAgentsPerRun: PROJECT_MAX_AGENTS_PER_RUN_LIMIT, keepFailedBranchesDays: 365 }))).toMatchObject({ maxAgentsPerRun: PROJECT_MAX_AGENTS_PER_RUN_LIMIT, keepFailedBranchesDays: 365 })
    for (const bad of [0, -3, 2.5, PROJECT_MAX_AGENTS_PER_RUN_LIMIT + 1, '7', Number.NaN]) {
      expect(Object.hasOwn(cleanProjectLimits(asProject({ maxAgentsPerRun: bad })), 'maxAgentsPerRun')).toBe(false)
    }
    for (const bad of [0, -3, 2.5, 366, '7', Number.NaN]) {
      expect(Object.hasOwn(cleanProjectLimits(asProject({ keepFailedBranchesDays: bad })), 'keepFailedBranchesDays')).toBe(false)
    }
    // 366 is a valid agent count but not a valid number of days.
    expect(cleanProjectLimits(asProject({ maxAgentsPerRun: 366, keepFailedBranchesDays: 366 }))).toMatchObject({ maxAgentsPerRun: 366 })
  })

  it('keeps the three booleans only as booleans', () => {
    expect(cleanProjectLimits(asProject({ schedulesNearPlanLimit: false, requireTestsPass: false }))).toMatchObject({ schedulesNearPlanLimit: false, requireTestsPass: false })
    for (const bad of ['true', 1, 0, null, {}]) {
      const out = cleanProjectLimits(asProject({ schedulesNearPlanLimit: bad, requireTestsPass: bad })) as unknown as Record<string, unknown>
      expect(Object.hasOwn(out, 'schedulesNearPlanLimit')).toBe(false)
      expect(Object.hasOwn(out, 'requireTestsPass')).toBe(false)
    }
  })

  it('does not add a key that was not there', () => {
    const out = cleanProjectLimits(project()) as unknown as Record<string, unknown>
    for (const k of ['maxDailyUsd', 'maxMonthlyUsd', 'onSpendLimit', 'maxAgentsPerRun', 'schedulesNearPlanLimit', 'mainBranch', 'requireTestsPass', 'testCommand', 'keepFailedBranchesDays']) {
      expect(Object.hasOwn(out, k)).toBe(false)
    }
  })
})

describe('cleanMainBranch', () => {
  it('accepts ordinary branch names and trims them', () => {
    expect(cleanMainBranch('main')).toBe('main')
    expect(cleanMainBranch('  develop ')).toBe('develop')
    expect(cleanMainBranch('release/2026.11')).toBe('release/2026.11')
    expect(cleanMainBranch('feature/a-b_c')).toBe('feature/a-b_c')
  })

  it('refuses option-like, control, hidden and malformed names', () => {
    const bad = [
      '-main',
      '--upload-pack=evil',
      '',
      '   ',
      'a\nb',
      'a\u0000b',
      'a​b',
      'a b',
      'a..b',
      'a@{1}',
      '@',
      'a//b',
      '/main',
      'main/',
      'main.',
      'main.lock',
      'feature/.hidden',
      'a~1',
      'a^',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      'x'.repeat(201),
      42,
      null,
      undefined
    ]
    for (const b of bad) expect(cleanMainBranch(b)).toBeUndefined()
    expect(cleanMainBranch('x'.repeat(200))).toBe('x'.repeat(200))
  })
})

describe('cleanTestCommand', () => {
  it('trims and keeps a one-line command', () => {
    expect(cleanTestCommand('  npm test -- --run  ')).toBe('npm test -- --run')
  })

  it('refuses multi-line, hidden, empty, over-long and non-string values', () => {
    for (const bad of ['npm test\nrm -rf /', 'npm\rtest', 'a b', 'a\u0000b', 'a‮b', '', '   ', 'x'.repeat(PROJECT_TEST_COMMAND_MAX_CHARS + 1), 5, null]) {
      expect(cleanTestCommand(bad)).toBeUndefined()
    }
    expect(cleanTestCommand('x'.repeat(PROJECT_TEST_COMMAND_MAX_CHARS))).toHaveLength(PROJECT_TEST_COMMAND_MAX_CHARS)
  })
})

describe('cleanRoleLimits', () => {
  it('keeps maxConcurrent in 1..limit and knowledgeWrite booleans', () => {
    const r = { ...role(), maxConcurrent: ROLE_MAX_CONCURRENT_LIMIT, knowledgeWrite: false }
    expect(cleanRoleLimits(r)).toBe(r)
    expect(cleanRoleLimits({ ...role(), maxConcurrent: 1 }).maxConcurrent).toBe(1)
  })

  it('drops an invalid maxConcurrent or knowledgeWrite', () => {
    for (const bad of [0, -1, 1.5, ROLE_MAX_CONCURRENT_LIMIT + 1, '2', null, Number.NaN]) {
      expect(Object.hasOwn(cleanRoleLimits({ ...role(), maxConcurrent: bad } as never), 'maxConcurrent')).toBe(false)
    }
    for (const bad of ['yes', 1, null]) {
      expect(Object.hasOwn(cleanRoleLimits({ ...role(), knowledgeWrite: bad } as never), 'knowledgeWrite')).toBe(false)
    }
  })
})

describe('ProjectStore normalizes the overhaul fields', () => {
  const messy = {
    maxDailyUsd: -2,
    maxMonthlyUsd: 40,
    onSpendLimit: 'explode',
    maxAgentsPerRun: 2.5,
    schedulesNearPlanLimit: 'yes',
    mainBranch: '--evil',
    requireTestsPass: true,
    testCommand: 'npm test\nrm -rf /',
    keepFailedBranchesDays: 400
  }

  it('on save', () => {
    const store = new ProjectStore(dataDir())
    const saved = store.save(asProject({ ...messy, roles: [{ ...role(), maxConcurrent: 99, knowledgeWrite: 'x' }] })) as unknown as Record<string, unknown>
    expect(saved.maxMonthlyUsd).toBe(40)
    expect(saved.requireTestsPass).toBe(true)
    for (const k of ['maxDailyUsd', 'onSpendLimit', 'maxAgentsPerRun', 'schedulesNearPlanLimit', 'mainBranch', 'testCommand', 'keepFailedBranchesDays']) {
      expect(Object.hasOwn(saved, k)).toBe(false)
    }
    const stored = store.get('p1')?.roles[0] as unknown as Record<string, unknown>
    expect(Object.hasOwn(stored, 'maxConcurrent')).toBe(false)
    expect(Object.hasOwn(stored, 'knowledgeWrite')).toBe(false)
  })

  it('on saveFromRenderer and saveInternal', () => {
    const store = new ProjectStore(dataDir())
    store.save(project())
    const viaRenderer = store.saveFromRenderer(asProject({ maxDailyUsd: 3, testCommand: 'a\nb', mainBranch: 'ok' })) as unknown as Record<string, unknown>
    expect(viaRenderer.maxDailyUsd).toBe(3)
    expect(viaRenderer.mainBranch).toBe('ok')
    expect(Object.hasOwn(viaRenderer, 'testCommand')).toBe(false)
    const viaInternal = store.saveInternal(asProject({ maxMonthlyUsd: 0, keepFailedBranchesDays: 7 })) as unknown as Record<string, unknown>
    expect(viaInternal.keepFailedBranchesDays).toBe(7)
    expect(Object.hasOwn(viaInternal, 'maxMonthlyUsd')).toBe(false)
  })

  it('on read of a hand-edited projects.json (and persists the clean copy)', () => {
    const dir = dataDir()
    const bad = { ...project({ roles: [{ ...role(), maxConcurrent: 0 }] }), ...messy }
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 2, projects: [bad] }), 'utf8')
    const store = new ProjectStore(dir)
    const read = store.get('p1') as unknown as Record<string, unknown>
    expect(read.maxMonthlyUsd).toBe(40)
    expect(Object.hasOwn(read, 'testCommand')).toBe(false)
    expect(Object.hasOwn(read, 'maxDailyUsd')).toBe(false)
    expect(Object.hasOwn(store.get('p1')?.roles[0] as object, 'maxConcurrent')).toBe(false)
    const onDisk = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')) as { projects: Record<string, unknown>[] }
    expect(Object.hasOwn(onDisk.projects[0], 'testCommand')).toBe(false)
    expect(onDisk.projects[0].maxMonthlyUsd).toBe(40)
  })
})
