import { describe, expect, it } from 'vitest'
import type { PermissionMode, Project, ProviderModel } from '@shared/types'
import { PERMISSION_MODES } from '@shared/types'
import {
  EFFORT_LABEL,
  defaultRunEffort,
  defaultRunModel,
  effortChoices,
  fitEffort,
  isNarrowingMode,
  isPermissiveMode,
  isWideningMode,
  LIVE_MODEL_HELP_ASSISTANT,
  LIVE_MODEL_HELP_TEAM,
  liveEffort,
  liveGoal,
  livePermissionChoices,
  livePermissionOutcome,
  livePermissionValue,
  MODEL_HELP_TEAM,
  metaPermissionMode,
  newRunPermissionChoices,
  offersInterruptToChange,
  permissionOutcomeText,
  reportsUnchangedOf,
  reportsUnchangedText,
  runPermissionMode,
  showsModeInMeta,
  startChoicesToSend,
  wideningCopy
} from './runSettings'

const role = (over: Partial<Project['roles'][number]>): Project['roles'][number] =>
  ({ id: 'r1', slug: 'orchestrator', name: 'Orchestrator', reportsTo: null, model: 'opus', ...over }) as Project['roles'][number]
const project = (over: Partial<Project> = {}): Pick<Project, 'roles' | 'provider' | 'permissionMode'> =>
  ({ roles: [role({})], provider: { id: 'claude', connection: 'anthropic' }, permissionMode: 'default', ...over }) as Pick<Project, 'roles' | 'provider' | 'permissionMode'>
const catalog: ProviderModel[] = [
  { id: 'claude-opus-4-5', label: 'Opus', connection: 'anthropic', family: 'claude', adapter: 'claude' } as ProviderModel,
  { id: 'claude-sonnet-4-5', label: 'Sonnet', connection: 'anthropic', family: 'claude', adapter: 'claude' } as ProviderModel
]

describe('effort', () => {
  it('names every level', () => {
    expect(Object.keys(EFFORT_LABEL)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('offers the adapter levels', () => {
    expect(effortChoices('codex')).toEqual(['low', 'medium', 'high'])
    expect(effortChoices('claude')).toHaveLength(5)
    expect(effortChoices('mock')).toHaveLength(5)
  })
  it('falls back to the highest offered level below', () => {
    expect(fitEffort('max', 'codex')).toEqual({ effort: 'high', fellBack: 'max' })
    expect(fitEffort('xhigh', 'codex')).toEqual({ effort: 'high', fellBack: 'xhigh' })
    expect(fitEffort('medium', 'codex')).toEqual({ effort: 'medium', fellBack: null })
    expect(fitEffort(undefined, 'codex')).toEqual({ effort: undefined, fellBack: null })
  })
  it('defaults to the root role effort for Team, none for Ask', () => {
    const p = project({ roles: [role({ effort: 'high' })] })
    expect(defaultRunEffort(p, false)).toBe('high')
    expect(defaultRunEffort(p, true)).toBeUndefined()
  })
})

describe('default model', () => {
  it('is the root model on the project connection, with its catalog label', () => {
    expect(defaultRunModel(project({ roles: [role({ model: 'claude-opus-4-5' })] }), { ask: false, catalog })).toEqual({
      model: 'claude-opus-4-5', connection: 'anthropic', adapter: 'claude', label: 'Opus'
    })
  })
  it('resolves the Ask assistant setting through the tier mapping', () => {
    const m = defaultRunModel(project(), { ask: true, quickRunModel: 'everyday', tierModels: { everyday: 'claude-sonnet-4-5' }, catalog })
    expect(m?.model).toBe('claude-sonnet-4-5')
    expect(m?.label).toBe('Sonnet')
  })
  it('is null for an inherit root and runs on mock for mock projects', () => {
    expect(defaultRunModel(project({ roles: [role({ model: 'inherit' })] }), { ask: false })).toBeNull()
    expect(defaultRunModel(project({ provider: { id: 'mock', connection: 'anthropic' } as Project['provider'] }), { ask: false, catalog })?.adapter).toBe('mock')
  })
})

describe('permission modes', () => {
  it('offers every mode on a new run, fewer on Chat and none on setup', () => {
    expect(newRunPermissionChoices()).toEqual(PERMISSION_MODES)
    expect(livePermissionChoices({ kind: 'work', quick: { folder: 'x' } as never })).toEqual(['default', 'dontAsk', 'plan'])
    expect(livePermissionChoices({ kind: 'setup' })).toEqual([])
  })
  it('agrees with main on narrowing for every pair', async () => {
    // Loaded by path: the web tsconfig does not include main's files; vitest resolves it all the same.
    const mainPath = '../../../main/runtime/runOverrides'
    const { canNarrowPermissionMode } = (await import(/* @vite-ignore */ mainPath)) as { canNarrowPermissionMode: (a: PermissionMode, b: PermissionMode) => boolean }
    for (const from of PERMISSION_MODES) for (const to of PERMISSION_MODES) {
      expect(isNarrowingMode(from, to)).toBe(canNarrowPermissionMode(from, to))
      expect(isWideningMode(from, to)).toBe(!canNarrowPermissionMode(from, to))
    }
  })
  it('marks permissive modes and meta visibility', () => {
    expect((['auto', 'acceptEdits', 'bypassPermissions'] as PermissionMode[]).every(isPermissiveMode)).toBe(true)
    expect((['default', 'dontAsk', 'plan'] as PermissionMode[]).some(isPermissiveMode)).toBe(false)
    expect(showsModeInMeta('default')).toBe(false)
    expect(showsModeInMeta('plan')).toBe(true)
  })
  it('says what stops asking; bypass is dangerous', () => {
    expect(wideningCopy('default', 'bypassPermissions').danger).toBe(true)
    expect(wideningCopy('default', 'acceptEdits').body).toContain('File edits')
    expect(wideningCopy('plan', 'default').body).toContain('this run only')
  })
  it('reads the run mode, else the project mode', () => {
    expect(runPermissionMode({ permissionMode: 'plan' }, { permissionMode: 'auto' })).toBe('plan')
    expect(runPermissionMode({}, { permissionMode: 'auto' })).toBe('auto')
  })
  it('words applied, saved and refused outcomes', () => {
    expect(permissionOutcomeText({ applied: true, run: { status: 'idle', permissionMode: 'plan' } }, 'plan').tone).toBe('ok')
    expect(permissionOutcomeText({ applied: false, run: { status: 'finished', permissionMode: 'plan' } }, 'plan')).toEqual({ tone: 'saved', text: 'Plan only applies from your next message.' })
    expect(permissionOutcomeText({ applied: false, reason: 'Not now.', run: { status: 'idle', permissionMode: 'default' } }, 'plan')).toEqual({ tone: 'refused', text: 'Not now.' })
  })
})

describe('live composer row', () => {
  const run = (over: Record<string, unknown> = {}) => ({ status: 'idle', kind: 'work', ...over }) as never
  it('shows the mode in force on a live run and the next-message mode on an ended one', () => {
    expect(livePermissionValue(run({ permissionMode: 'plan' }), { permissionMode: 'auto' })).toEqual({ mode: 'plan', next: false })
    expect(livePermissionValue(run({ status: 'finished', permissionMode: 'bypassPermissions', permissionModeChosen: true }), { permissionMode: 'default' })).toEqual({ mode: 'bypassPermissions', next: true })
    // Not chosen: the continuation re-reads the project's mode (or the run's exec override), not what the run had.
    expect(livePermissionValue(run({ status: 'paused', permissionMode: 'plan' }), { permissionMode: 'auto' })).toEqual({ mode: 'auto', next: true })
    expect(livePermissionValue(run({ status: 'error', overrides: { permissionMode: 'dontAsk' } }), { permissionMode: 'auto' })).toEqual({ mode: 'dontAsk', next: true })
  })
  it('shows a trust-restricted Chat run as asking, not as the project\'s auto mode', () => {
    const chat = { status: 'idle', kind: 'work', quick: { folder: 'x' } } as never
    expect(livePermissionValue(chat, { permissionMode: 'auto' }).mode).toBe('default')
    expect(metaPermissionMode(chat, { permissionMode: 'auto' })).toBeNull()
    expect(livePermissionValue({ ...(chat as object), permissionMode: 'plan' } as never, { permissionMode: 'auto' }).mode).toBe('plan')
  })
  it('reads reportsUnchanged defensively and words it with the right number', () => {
    expect(reportsUnchangedOf({ applied: true })).toBe(0)
    expect(reportsUnchangedOf({ reportsUnchanged: 'x' })).toBe(0)
    expect(reportsUnchangedOf({ reportsUnchanged: -2 })).toBe(0)
    expect(reportsUnchangedOf({ reportsUnchanged: 2 })).toBe(2)
    expect(reportsUnchangedText(0)).toBe('')
    expect(reportsUnchangedText(1)).toBe('1 running report keeps the earlier mode until it finishes.')
    expect(reportsUnchangedText(3)).toBe('3 running reports keep the earlier mode until they finish.')
  })
  it('adds the kept-earlier-mode line to an applied outcome only', () => {
    const base = { applied: true, reportsUnchanged: 2, run: { status: 'running', permissionMode: 'plan' } } as const
    expect(livePermissionOutcome(base, 'plan').message).toBe('Permission mode is now Plan only. 2 running reports keep the earlier mode until they finish.')
    expect(livePermissionOutcome({ ...base, applied: false, reason: 'Nope.' }, 'plan')).toMatchObject({ tone: 'refused', message: 'Nope.', reports: '' })
    expect(livePermissionOutcome({ applied: true, run: { status: 'idle', permissionMode: 'plan' } }, 'plan').message).toBe('Permission mode is now Plan only.')
  })
  it('offers an interrupt only for a refusal on a running run', () => {
    expect(offersInterruptToChange({ tone: 'refused' }, 'running')).toBe(true)
    expect(offersInterruptToChange({ tone: 'refused' }, 'idle')).toBe(false)
    expect(offersInterruptToChange({ tone: 'saved' }, 'running')).toBe(false)
  })
  it('takes effort and goal from the run, else the root role, and only for team runs', () => {
    const p = project({ roles: [role({ effort: 'medium' })] }) as Project
    expect(liveEffort({ rootEffort: 'max', kind: 'work' }, p)).toBe('max')
    expect(liveEffort({ kind: 'work' }, p)).toBe('medium')
    expect(liveEffort({ kind: 'work', team: 'single' }, p)).toBeUndefined()
    expect(liveEffort({ kind: 'work', quick: {} as never }, p)).toBeUndefined()
    expect(liveEffort({ kind: 'setup' }, p)).toBeUndefined()
    const auto = { staffing: 'auto', staffingGoal: 'cost' } as Project
    expect(liveGoal({ kind: 'work', overrides: { goal: 'speed' } }, auto)).toBe('speed')
    expect(liveGoal({ kind: 'work' }, auto)).toBe('cost')
    expect(liveGoal({ kind: 'work', team: 'single' }, auto)).toBeNull()
    expect(liveGoal({ kind: 'work' }, { staffing: 'fixed' } as Project)).toBeNull()
    expect(liveGoal({ kind: 'setup' }, auto)).toBeNull()
  })
  it('puts a mode in the meta bar for work runs only, when it is not the plain default', () => {
    expect(metaPermissionMode({ kind: 'work', permissionMode: 'bypassPermissions' }, { permissionMode: 'default' })).toBe('bypassPermissions')
    expect(metaPermissionMode({ kind: 'work' }, { permissionMode: 'auto' })).toBe('auto')
    expect(metaPermissionMode({ kind: 'work', permissionMode: 'default' }, { permissionMode: 'auto' })).toBeNull()
    expect(metaPermissionMode({ kind: 'setup', permissionMode: 'auto' }, { permissionMode: 'auto' })).toBeNull()
  })
  it('says roles set to inherit follow the lead on team model help', () => {
    expect(MODEL_HELP_TEAM).toContain('Roles set to inherit follow it')
    expect(LIVE_MODEL_HELP_TEAM).toContain('Roles set to inherit follow it')
    expect(LIVE_MODEL_HELP_ASSISTANT).toBe('Applies to this conversation’s lead agent.')
  })
})

describe('startChoicesToSend', () => {
  const defaults = { model: { model: 'claude-opus-4-5', connection: 'anthropic', adapter: 'claude' as const, label: 'Opus' }, effort: 'max' as const, permissionMode: 'default' as PermissionMode }
  it('sends nothing at the defaults', () => {
    expect(startChoicesToSend({ model: null, effort: null, permissionMode: null }, defaults, 'claude')).toEqual({})
    expect(startChoicesToSend({ model: { model: 'claude-opus-4-5', connection: 'anthropic' }, effort: null, permissionMode: 'default' }, defaults, 'claude')).toEqual({})
  })
  it('sends picks that differ', () => {
    expect(startChoicesToSend({ model: { model: 'claude-sonnet-4-5', connection: 'anthropic' }, effort: 'low', permissionMode: 'plan' }, defaults, 'claude')).toEqual({
      modelSelection: { model: 'claude-sonnet-4-5', connection: 'anthropic' }, effort: 'low', permissionMode: 'plan'
    })
  })
  it('never sends an effort the adapter does not take', () => {
    expect(startChoicesToSend({ model: { model: 'gpt-5', connection: 'openai' }, effort: 'xhigh', permissionMode: null }, defaults, 'codex').effort).toBe('high')
    // The default effort (max) does not fit a Codex pick: it is sent fitted.
    expect(startChoicesToSend({ model: { model: 'gpt-5', connection: 'openai' }, effort: null, permissionMode: null }, defaults, 'codex').effort).toBe('high')
  })
})
