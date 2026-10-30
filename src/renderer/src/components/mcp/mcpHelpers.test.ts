import { describe, expect, it } from 'vitest'
import type { McpRegistryEntry } from '@shared/types'
import { dedupeRegistryEntries } from './mcpHelpers'

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
