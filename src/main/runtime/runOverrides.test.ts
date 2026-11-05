import { describe, expect, it } from 'vitest'
import { DEFAULT_HEADLESS_DECISION_POLICY, DEFAULT_MAX_AUTO_CONTINUES, PERMISSION_MODES } from '@shared/types'
import type { PermissionMode, Project, RunOverrides } from '@shared/types'
import { canNarrowPermissionMode, effectiveRunProject, execBudgetUsd, overridesWidening, runOverridesArgs } from './runOverrides'

const project = (over: Partial<Project> = {}): Project =>
  ({ id: 'p1', name: 'P', path: '/tmp/p', permissionMode: 'default', roles: [], ...over }) as unknown as Project

describe('canNarrowPermissionMode', () => {
  // Rows: project mode; the set lists the override modes that narrow it.
  const allowed: Record<PermissionMode, PermissionMode[]> = {
    default: ['default', 'plan', 'dontAsk'],
    acceptEdits: ['acceptEdits', 'plan', 'dontAsk', 'default'],
    auto: ['auto', 'plan', 'dontAsk', 'default', 'acceptEdits'],
    dontAsk: ['dontAsk', 'plan', 'default'],
    plan: ['plan'],
    bypassPermissions: ['bypassPermissions', 'plan', 'dontAsk', 'default', 'acceptEdits', 'auto']
  }
  it('covers the six modes', () => expect(PERMISSION_MODES).toHaveLength(6))
  for (const projectMode of PERMISSION_MODES) {
    for (const overrideMode of PERMISSION_MODES) {
      const want = allowed[projectMode].includes(overrideMode)
      it(`${projectMode} -> ${overrideMode}: ${want}`, () => {
        expect(canNarrowPermissionMode(projectMode, overrideMode)).toBe(want)
      })
    }
  }
})

describe('overridesWidening', () => {
  it('is empty for narrowing overrides', () => {
    expect(overridesWidening(project({ maxBudgetUsd: 5 }), { permissionMode: 'plan', autoContinue: false, maxAutoContinues: 1, maxBudgetUsd: 2 })).toEqual([])
  })
  it('flags a wider permission mode', () => {
    expect(overridesWidening(project(), { permissionMode: 'bypassPermissions' })).toEqual(['permissionMode'])
  })
  it('flags autoContinue true only when the project turned it off', () => {
    expect(overridesWidening(project({ autoContinue: false }), { autoContinue: true })).toEqual(['autoContinue'])
    expect(overridesWidening(project(), { autoContinue: true })).toEqual([])
  })
  it('flags more automatic continues than the project (default included)', () => {
    expect(overridesWidening(project(), { maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES + 1 })).toEqual(['maxAutoContinues'])
    expect(overridesWidening(project(), { maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES })).toEqual([])
    expect(overridesWidening(project({ maxAutoContinues: 3 }), { maxAutoContinues: 4 })).toEqual(['maxAutoContinues'])
  })
  it('flags a bigger budget only when the project has one', () => {
    expect(overridesWidening(project({ maxBudgetUsd: 1 }), { maxBudgetUsd: 2 })).toEqual(['maxBudgetUsd'])
    expect(overridesWidening(project(), { maxBudgetUsd: 200 })).toEqual([])
  })
  it('flags allowUnpricedBudget only when the project enforces a budget', () => {
    expect(overridesWidening(project({ maxBudgetUsd: 0 }), { allowUnpricedBudget: true })).toEqual(['allowUnpricedBudget'])
    expect(overridesWidening(project(), { allowUnpricedBudget: true })).toEqual([])
  })
  it('always flags allowPeerMessages', () => {
    expect(overridesWidening(project(), { allowPeerMessages: true })).toEqual(['allowPeerMessages'])
    expect(overridesWidening(project(), { allowPeerMessages: false })).toEqual([])
  })
})

describe('effectiveRunProject', () => {
  it('returns an unchanged copy without overrides', () => {
    const p = project()
    const e = effectiveRunProject(p, undefined)
    expect(e).toEqual(p)
    expect(e).not.toBe(p)
  })
  it('applies narrowing overrides', () => {
    const e = effectiveRunProject(project({ permissionMode: 'auto', maxBudgetUsd: 5 }), {
      permissionMode: 'default',
      autoContinue: false,
      maxAutoContinues: 2,
      maxBudgetUsd: 1
    })
    expect(e).toMatchObject({ permissionMode: 'default', autoContinue: false, maxAutoContinues: 2, maxBudgetUsd: 1 })
  })
  it('ignores widening overrides without allowWidening', () => {
    const p = project({ permissionMode: 'default', autoContinue: false, maxAutoContinues: 3, maxBudgetUsd: 1 })
    const o: RunOverrides = { permissionMode: 'bypassPermissions', autoContinue: true, maxAutoContinues: 10, maxBudgetUsd: 9 }
    expect(effectiveRunProject(p, o)).toMatchObject({ permissionMode: 'default', autoContinue: false, maxAutoContinues: 3, maxBudgetUsd: 1 })
    expect(effectiveRunProject(p, o, { allowWidening: true })).toMatchObject({
      permissionMode: 'bypassPermissions',
      autoContinue: true,
      maxAutoContinues: 10,
      maxBudgetUsd: 9
    })
  })
  it('sets a budget when the project has none', () => {
    expect(effectiveRunProject(project(), { maxBudgetUsd: 0 }).maxBudgetUsd).toBe(0)
  })
  it('re-clamps when the project tightened', () => {
    const o: RunOverrides = { permissionMode: 'acceptEdits', maxAutoContinues: 10, maxBudgetUsd: 3 }
    const before = effectiveRunProject(project({ permissionMode: 'auto', maxAutoContinues: 20, maxBudgetUsd: 5 }), o)
    expect(before).toMatchObject({ permissionMode: 'acceptEdits', maxAutoContinues: 10, maxBudgetUsd: 3 })
    const after = effectiveRunProject(project({ permissionMode: 'default', maxAutoContinues: 4, maxBudgetUsd: 2 }), o)
    expect(after).toMatchObject({ permissionMode: 'default', maxAutoContinues: 4, maxBudgetUsd: 2 })
  })
})

describe('execBudgetUsd', () => {
  it('keeps a 0 budget on exec runs', () => {
    expect(execBudgetUsd(project({ maxBudgetUsd: 0 }), { execMode: true })).toBe(0)
    expect(execBudgetUsd(project({ maxBudgetUsd: 0 }), { maxBudgetUsd: 0 })).toBe(0)
  })
  it('is undefined for non-exec runs without an override budget', () => {
    expect(execBudgetUsd(project({ maxBudgetUsd: 3 }), undefined)).toBeUndefined()
    expect(execBudgetUsd(project({ maxBudgetUsd: 3 }), { permissionMode: 'plan' })).toBeUndefined()
  })
  it('is undefined on an exec run with no budget at all', () => {
    expect(execBudgetUsd(project(), { execMode: true })).toBeUndefined()
  })
})

describe('runOverridesArgs', () => {
  const bad = (raw: unknown) => {
    try {
      runOverridesArgs(raw)
    } catch (e) {
      return (e as { code?: string }).code
    }
    return 'no throw'
  }
  it('accepts nothing', () => {
    expect(runOverridesArgs(undefined)).toBeUndefined()
    expect(runOverridesArgs(null)).toBeUndefined()
    expect(runOverridesArgs({})).toBeUndefined()
  })
  it('refuses non-objects', () => {
    expect(bad('x')).toBe('bad_request')
    expect(bad([])).toBe('bad_request')
    expect(bad(new Date())).toBe('bad_request')
  })
  it('refuses wrong types and ranges', () => {
    expect(bad({ permissionMode: 'yolo' })).toBe('bad_request')
    expect(bad({ autoContinue: 'yes' })).toBe('bad_request')
    expect(bad({ execMode: 1 })).toBe('bad_request')
    expect(bad({ maxAutoContinues: -1 })).toBe('bad_request')
    expect(bad({ maxAutoContinues: 501 })).toBe('bad_request')
    expect(bad({ maxAutoContinues: 1.5 })).toBe('bad_request')
    expect(bad({ maxBudgetUsd: -0.01 })).toBe('bad_request')
    expect(bad({ maxBudgetUsd: Infinity })).toBe('bad_request')
    expect(bad({ maxBudgetUsd: '1' })).toBe('bad_request')
    expect(bad({ execStallTimeoutMs: NaN })).toBe('bad_request')
    expect(bad({ execChainId: '' })).toBe('bad_request')
    expect(bad({ execChainId: 'a b' })).toBe('bad_request')
    expect(bad({ execChainId: 'x'.repeat(101) })).toBe('bad_request')
    expect(bad({ decisionPolicy: 'deny' })).toBe('bad_request')
    expect(bad({ decisionPolicy: { permission: 'allow' } })).toBe('bad_request')
    expect(bad({ decisionPolicy: { maxAutoDenials: 1.5 } })).toBe('bad_request')
    expect(bad({ decisionPolicy: { waitTimeoutMs: -1 } })).toBe('bad_request')
  })
  it('keeps valid values and drops unknown keys', () => {
    expect(
      runOverridesArgs({
        permissionMode: 'plan',
        autoContinue: false,
        maxAutoContinues: 0,
        maxBudgetUsd: 0,
        execMode: true,
        execChainId: 'chain_1-a',
        execStallTimeoutMs: 1000,
        surprise: 1
      })
    ).toEqual({ permissionMode: 'plan', autoContinue: false, maxAutoContinues: 0, maxBudgetUsd: 0, execMode: true, execChainId: 'chain_1-a', execStallTimeoutMs: 1000 })
    expect(runOverridesArgs({ surprise: 1 })).toBeUndefined()
  })
  it('fills a partial policy from the defaults', () => {
    const o = runOverridesArgs({ decisionPolicy: { question: 'conservative', maxAutoDenials: 2, extra: 'x' } })
    expect(o?.decisionPolicy).toEqual({
      permission: DEFAULT_HEADLESS_DECISION_POLICY.permission,
      rules: DEFAULT_HEADLESS_DECISION_POLICY.rules,
      mcpInstall: DEFAULT_HEADLESS_DECISION_POLICY.mcpInstall,
      question: 'conservative',
      proposal: DEFAULT_HEADLESS_DECISION_POLICY.proposal,
      merge: DEFAULT_HEADLESS_DECISION_POLICY.merge,
      maxAutoDenials: 2
    })
  })
})
