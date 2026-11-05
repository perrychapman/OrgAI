import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import { isPinnedVersion, pinnedVersionOf } from './mcpVersion'

function spec(over: Partial<McpServerSpec>): McpServerSpec {
  return { id: 'mcp_1', name: 'x', transport: 'stdio', command: 'npx', enabled: true, source: 'agent', addedAt: '2026-01-01', ...over }
}

describe('isPinnedVersion', () => {
  it('accepts exact versions only', () => {
    expect(isPinnedVersion('1.2.3')).toBe(true)
    expect(isPinnedVersion('1.2.3-beta.1')).toBe(true)
    for (const v of ['latest', '^1.2.3', '~1.2.3', '*', '1.x', '>=1.0.0', '', undefined, null]) expect(isPinnedVersion(v)).toBe(false)
  })
})

describe('pinnedVersionOf', () => {
  it('reads npm and scoped suffixes', () => {
    expect(pinnedVersionOf(spec({ args: ['-y', 'left-pad@1.3.0'] }))).toBe('1.3.0')
    expect(pinnedVersionOf(spec({ args: ['-y', '@scope/pkg@2.0.1'] }))).toBe('2.0.1')
  })
  it('reads pip style', () => {
    expect(pinnedVersionOf(spec({ command: 'uvx', args: ['mcp-thing==0.4.2'] }))).toBe('0.4.2')
  })
  it('rejects latest, ranges and missing', () => {
    expect(pinnedVersionOf(spec({ args: ['-y', 'pkg@latest'] }))).toBeNull()
    expect(pinnedVersionOf(spec({ args: ['-y', 'pkg@^1.0.0'] }))).toBeNull()
    expect(pinnedVersionOf(spec({ args: ['-y', 'pkg'] }))).toBeNull()
  })
  it('does not let a registry version vouch for an unpinned arg', () => {
    const registry = { name: 'a/b', version: '1.0.0', registryType: 'npm', identifier: 'pkg' }
    expect(pinnedVersionOf(spec({ args: ['-y', 'pkg@latest'], registry }))).toBeNull()
    expect(pinnedVersionOf(spec({ args: [], registry }))).toBe('1.0.0')
  })
  it('has no version for remote servers', () => {
    expect(pinnedVersionOf(spec({ transport: 'http', url: 'https://x.dev/mcp' }))).toBeNull()
  })
})
