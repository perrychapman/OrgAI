import { describe, expect, it } from 'vitest'
import type { McpServerInfo } from '@shared/types'
import { nextOverrides, perProjectMissingLine, perProjectState } from './mcpHelpers'

function info(extra: Record<string, unknown>, over: Record<string, unknown> = {}): McpServerInfo {
  return {
    spec: { id: 's1', name: 'idp', transport: 'stdio', enabled: true, command: 'npx', libraryId: 'lib1', addedAt: '', source: 'library', ...extra },
    envSet: [],
    headersSet: [],
    missingSecrets: [],
    auth: { state: 'notRequired' },
    ...over
  } as unknown as McpServerInfo
}

describe('perProjectState', () => {
  it('is not declared without slots', () => {
    expect(perProjectState(info({})).declared).toBe(false)
  })
  it('counts empty plain and secret slots when secrets are this project\'s own', () => {
    const s = perProjectState(info({ perProjectEnv: ['TENANT_URL'], secretEnv: ['API_TOKEN'], envOverrides: {} }, { secretScope: 'project' }))
    expect(s.declared).toBe(true)
    expect(s.missingPlain).toEqual(['TENANT_URL'])
    expect(s.missingSecrets).toEqual(['API_TOKEN'])
    expect(s.missingCount).toBe(2)
  })
  it('ignores secret slots held by the library', () => {
    const s = perProjectState(info({ perProjectEnv: ['A'], secretEnv: ['K'], envOverrides: { A: 'x' } }))
    expect(s.secrets).toEqual([])
    expect(s.missingCount).toBe(0)
  })
  it('reads header overrides for remote servers', () => {
    const s = perProjectState(info({ transport: 'http', perProjectEnv: ['X-Tenant'], headerOverrides: { 'X-Tenant': 'acme' } }))
    expect(s.plain).toEqual([{ name: 'X-Tenant', value: 'acme' }])
    expect(s.missingCount).toBe(0)
  })
})

describe('nextOverrides', () => {
  it('sets, replaces and removes by name without touching the input', () => {
    const cur = { A: '1', B: '2' }
    expect(nextOverrides(cur, 'A', '9')).toEqual({ A: '9', B: '2' })
    expect(nextOverrides(cur, 'B', '')).toEqual({ A: '1' })
    expect(cur).toEqual({ A: '1', B: '2' })
  })
})

describe('perProjectMissingLine', () => {
  it('pluralises', () => {
    expect(perProjectMissingLine(1, 'engagement')).toBe('Needs 1 value for this engagement before agents can use it.')
    expect(perProjectMissingLine(2, 'project')).toBe('Needs 2 values for this project before agents can use it.')
  })
})
