import { describe, expect, it } from 'vitest'
import { newProject } from './defaults'
import { ARCHITECT_SLUG, architectRole, setupKindLabel, setupPending } from './setup'
import type { SetupState } from './types'

describe('setupPending', () => {
  const base = newProject({ name: 'X', path: '/x', brief: '' })

  it('is false without a setup record', () => {
    expect(setupPending(base)).toBe(false)
  })

  it('is true for every state except complete', () => {
    const states: SetupState[] = ['pending', 'in_progress', 'complete']
    for (const state of states) {
      expect(setupPending({ ...base, setup: { kind: 'existing', state } })).toBe(state !== 'complete')
    }
  })

  it('is true for a freshly created project that asked for setup', () => {
    expect(setupPending(newProject({ name: 'X', path: '/x', brief: '', setupKind: 'new' }))).toBe(true)
  })
})

describe('architectRole', () => {
  it('is a read-only, non-spawning root role', () => {
    const r = architectRole()
    expect(r.slug).toBe(ARCHITECT_SLUG)
    expect(r.canSpawn).toBe(false)
    expect(r.reportsTo).toBeNull()
    expect(r.tools).not.toContain('Edit')
    expect(r.tools).not.toContain('Write')
  })

  it('labels setup kinds', () => {
    expect(setupKindLabel('new')).toBe('new project')
    expect(setupKindLabel('existing')).toBe('existing project')
  })
})
