import { describe, expect, it } from 'vitest'
import { appReferenceArgs } from './args'

describe('appReferenceArgs', () => {
  it('rebuilds a valid query and drops unknown fields', () => {
    expect(appReferenceArgs({ action: 'search', query: 'theme', budget: 1000, extra: 1, __proto__: { x: 1 } })).toEqual({ action: 'search', query: 'theme', budget: 1000 })
    expect(appReferenceArgs({ action: 'read', id: 'surface:dashboard', query: null })).toEqual({ action: 'read', id: 'surface:dashboard' })
    expect(appReferenceArgs({ action: 'status' })).toEqual({ action: 'status' })
  })
  it('refuses a bad shape with a readable error', () => {
    for (const bad of [null, 'x', [], {}, { action: 'nope' }, { action: 7 }]) expect(() => appReferenceArgs(bad)).toThrow(/reference/)
    expect(() => appReferenceArgs({ action: 'search', query: 5 })).toThrow(/text/)
    expect(() => appReferenceArgs({ action: 'read', id: {} })).toThrow(/text/)
    expect(() => appReferenceArgs({ action: 'search', query: 'a', budget: Infinity })).toThrow(/number/)
    expect(() => appReferenceArgs({ action: 'search', query: 'a', budget: '9' })).toThrow(/number/)
  })
})
