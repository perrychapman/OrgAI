import { describe, expect, it } from 'vitest'
import type { McpRegistryEntry } from '@shared/types'
import { dedupeRegistryEntries, secretClashLine } from './mcpHelpers'

describe('secretClashLine', () => {
  it('names the variable and the one other server', () => {
    expect(secretClashLine({ envName: 'GITHUB_TOKEN', others: ['github'] })).toBe(
      'Shares the secret name GITHUB_TOKEN with github. On the OpenAI connection, a run starts only one of them when their values differ.'
    )
  })

  it('lists several other servers', () => {
    expect(secretClashLine({ envName: 'TOKEN', others: ['a', 'b', 'c'] })).toBe(
      'Shares the secret name TOKEN with a, b and c. On the OpenAI connection, a run starts only one of them when their values differ.'
    )
    expect(secretClashLine({ envName: 'TOKEN', others: ['a', 'b'] })).toContain('with a and b.')
  })
})

const entry = (name: string, version: string, status?: McpRegistryEntry['status']): McpRegistryEntry => ({
  name,
  version,
  description: '',
  packages: [],
  remotes: [],
  status
})

describe('dedupeRegistryEntries', () => {
  it('keeps one entry per name and version and drops deleted ones', () => {
    const out = dedupeRegistryEntries([entry('a/x', '1.0.0'), entry('a/x', '1.0.0'), entry('a/x', '1.1.0'), entry('b/y', '2.0.0', 'deleted')])
    expect(out.map((e) => `${e.name}@${e.version}`)).toEqual(['a/x@1.0.0', 'a/x@1.1.0'])
  })
})
