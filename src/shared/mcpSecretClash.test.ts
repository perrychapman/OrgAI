import { describe, expect, it } from 'vitest'
import { secretEnvClashes, type McpSecretClashSpec } from './mcpSecretClash'

const stdio = (id: string, secretEnv: string[], extra: Partial<McpSecretClashSpec> = {}): McpSecretClashSpec => ({
  id,
  name: `srv-${id}`,
  transport: 'stdio',
  enabled: true,
  secretEnv,
  ...extra
})

describe('secretEnvClashes', () => {
  it('reports a shared name across stdio servers for each server', () => {
    const r = secretEnvClashes([stdio('a', ['TOKEN']), stdio('b', ['TOKEN']), stdio('c', ['OTHER'])])
    expect(r).toEqual({
      a: [{ envName: 'TOKEN', others: ['srv-b'] }],
      b: [{ envName: 'TOKEN', others: ['srv-a'] }]
    })
  })

  it('lists every other server sharing the name', () => {
    const r = secretEnvClashes([stdio('a', ['TOKEN']), stdio('b', ['TOKEN']), stdio('c', ['TOKEN'])])
    expect(r.a).toEqual([{ envName: 'TOKEN', others: ['srv-b', 'srv-c'] }])
    expect(r.c).toEqual([{ envName: 'TOKEN', others: ['srv-a', 'srv-b'] }])
  })

  it('ignores http servers, disabled servers and a single server', () => {
    expect(secretEnvClashes([stdio('a', ['TOKEN'])])).toEqual({})
    expect(
      secretEnvClashes([
        stdio('a', ['TOKEN']),
        stdio('b', ['TOKEN'], { transport: 'http' }),
        stdio('c', ['TOKEN'], { enabled: false })
      ])
    ).toEqual({})
    expect(secretEnvClashes([stdio('a', ['TOKEN', 'TOKEN'])])).toEqual({})
    expect(secretEnvClashes([stdio('a', []), stdio('b', [], { secretEnv: undefined })])).toEqual({})
  })

  it('lists several shared names', () => {
    const r = secretEnvClashes([stdio('a', ['TOKEN', 'KEY', 'MINE']), stdio('b', ['KEY', 'TOKEN'])])
    expect(r.a).toEqual([
      { envName: 'TOKEN', others: ['srv-b'] },
      { envName: 'KEY', others: ['srv-b'] }
    ])
    expect(r.b).toHaveLength(2)
  })
})
