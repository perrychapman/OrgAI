import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, Project, Role } from '@shared/types'

const save = vi.fn<(p: Project) => Promise<Project>>()
vi.stubGlobal('window', {
  orgai: { projects: { save } },
  dispatchEvent: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  location: { hash: '' }
})
vi.stubGlobal('Event', class {})

const { useAppStore } = await import('./useAppStore')

const role = (id: string, name: string): Role =>
  ({ id, slug: id, name, description: '', responsibilities: [], prompt: '', tools: [], model: 'inherit', canSpawn: false, spawnable: [], reportsTo: null, position: { x: 0, y: 0 }, color: '#000' }) as Role
const srv = (id: string, roles?: string[]): McpServerSpec => ({ id, roles }) as unknown as McpServerSpec
const project = (roles: Role[], mcpServers: McpServerSpec[]): Project => ({ id: 'p1', name: 'P', path: '/p', roles, mcpServers }) as unknown as Project

describe('store: debounced project save (carry-over c)', () => {
  afterEach(() => {
    vi.useRealTimers()
    save.mockReset()
  })

  it('takes only mcpServers from the saved project; a newer roles edit survives', async () => {
    vi.useFakeTimers()
    useAppStore.setState({ projects: [project([role('a', 'Dev')], [srv('db', ['dev'])])] })
    // Main moved the old slug to an id grant, and answers with its (older) roles.
    let resolve!: (p: Project) => void
    save.mockImplementation(() => new Promise<Project>((r) => (resolve = r)))
    useAppStore.getState().updateRoles('p1', (roles) => roles.map((r) => ({ ...r, name: 'Developer' })))
    await vi.advanceTimersByTimeAsync(400)
    expect(save).toHaveBeenCalledTimes(1)
    // A newer edit lands before main answers.
    useAppStore.setState((s) => ({ projects: s.projects.map((p) => ({ ...p, roles: p.roles.map((r) => ({ ...r, name: 'Developer 2' })) })) }))
    resolve(project([role('a', 'Developer')], [srv('db', [])]))
    await vi.runAllTimersAsync()
    const p = useAppStore.getState().projects[0]
    expect(p.mcpServers).toEqual([srv('db', [])])
    expect(p.roles[0].name).toBe('Developer 2')
  })

  it('a failed save changes nothing', async () => {
    vi.useFakeTimers()
    useAppStore.setState({ projects: [project([role('a', 'Dev')], [srv('db', ['dev'])])] })
    save.mockRejectedValue(new Error('disk'))
    useAppStore.getState().updateRoles('p1', (roles) => roles)
    await vi.runAllTimersAsync()
    expect(useAppStore.getState().projects[0].mcpServers).toEqual([srv('db', ['dev'])])
  })
})
