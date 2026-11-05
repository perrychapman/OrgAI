import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/types'
import { overlayOwnItems } from './runManager'

const role = (id: string, mcpServers?: string[]): Role =>
  ({ id, slug: id, name: id, description: '', responsibilities: [], prompt: '', tools: [], model: 'inherit', canSpawn: false, spawnable: [], reportsTo: null, position: { x: 0, y: 0 }, color: '#000000', ...(mcpServers ? { mcpServers } : {}) }) as Role
const item = (id: string, name: string, extra: { libraryId?: string; v?: number } = {}): { id: string; name: string; libraryId?: string; v?: number } => ({ id, name, ...extra })

describe('overlayOwnItems: what an approved change moves onto a live run', () => {
  it('takes only the named server; a pulled removal, change or addition in the same save stays out', () => {
    const live = [item('a', 'alpha', { v: 1 }), item('b', 'beta', { v: 1 }), item('c', 'gamma', { v: 1 })]
    // The save approved a change to alpha. A pull removed beta, changed gamma and added delta.
    const saved = [item('a', 'alpha', { v: 2 }), item('c', 'gamma', { v: 2 }), item('d', 'delta', { v: 2 })]
    const { items } = overlayOwnItems(live, saved, [], [], 'mcpServers', { ids: ['a'], names: ['alpha'] })
    expect(items).toEqual([item('a', 'alpha', { v: 2 }), item('b', 'beta', { v: 1 }), item('c', 'gamma', { v: 1 })])
  })

  it('moves only the grants to the named item', () => {
    const liveRoles = [role('r', ['a', 'b'])]
    // Approved: r gains n. Pulled: r loses b and gains x.
    const savedRoles = [role('r', ['a', 'n', 'x'])]
    const { roles } = overlayOwnItems([item('a', 'alpha'), item('b', 'beta')], [item('a', 'alpha'), item('n', 'new'), item('x', 'pulled')], liveRoles, savedRoles, 'mcpServers', { ids: ['n'], names: ['new'] })
    expect(roles[0].mcpServers).toEqual(['a', 'b', 'n'])
  })

  it('a removal the change named removes the item and its grants', () => {
    const { items, roles } = overlayOwnItems([item('a', 'alpha'), item('b', 'beta')], [item('b', 'beta')], [role('r', ['a', 'b'])], [role('r', ['b'])], 'mcpServers', { ids: ['a'], names: [] })
    expect(items).toEqual([item('b', 'beta')])
    expect(roles[0].mcpServers).toEqual(['b'])
  })

  it('a new id for the same name replaces in place, a library id matches its link, and unset lists stay unset', () => {
    const replaced = overlayOwnItems([item('a', 'alpha')], [item('a2', 'alpha')], [], [], 'skills', { ids: [], names: ['alpha'] })
    expect(replaced.items).toEqual([item('a2', 'alpha')])
    const linked = overlayOwnItems([item('s', 'one', { libraryId: 'lib', v: 1 })], [item('s', 'one', { libraryId: 'lib', v: 2 })], [], [], 'skills', { ids: ['lib'], names: [] })
    expect(linked.items?.[0].v).toBe(2)
    const none = overlayOwnItems(undefined, undefined, [role('r')], [role('r')], 'skills', { ids: ['x'], names: [] })
    expect(none.items).toBeUndefined()
    expect(none.roles[0].skills).toBeUndefined()
  })
})
