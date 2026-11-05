import { describe, expect, it } from 'vitest'
import { CONNECTORS } from '@shared/connectors'
import { servicesForRole, serviceFor } from './roleServices'

const base = { transport: 'stdio', command: 'x', args: [], env: {} }
const spec = (o: Record<string, unknown>): never => ({ ...base, enabled: true, ...o }) as never

describe('roleServices', () => {
  it('names connector servers by catalog name and marks custom ones', () => {
    const c = CONNECTORS[0]
    expect(serviceFor(spec({ id: 'a', name: 'raw', connectorId: c.id }))).toMatchObject({ label: c.name, custom: false })
    expect(serviceFor(spec({ id: 'b', name: 'My tool' }))).toMatchObject({ label: 'My tool', custom: true, initial: 'MT' })
  })

  it('lists only enabled servers the role may use', () => {
    const project = {
      mcpServers: [
        spec({ id: 'all', name: 'All' }),
        spec({ id: 'off', name: 'Off', enabled: false }),
        spec({ id: 'mine', name: 'Mine', roles: ['dev'] }),
        spec({ id: 'other', name: 'Other', roles: ['qa'] }),
        spec({ id: 'granted', name: 'Granted', roles: ['qa'] })
      ]
    }
    const ids = servicesForRole(project, { slug: 'dev', mcpServers: ['granted'] }).map((s) => s.id)
    expect(ids).toEqual(['all', 'mine', 'granted'])
    expect(servicesForRole({ mcpServers: undefined }, { slug: 'dev' })).toEqual([])
  })
})
