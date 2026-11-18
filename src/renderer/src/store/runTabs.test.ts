import { beforeEach, describe, expect, it, vi } from 'vitest'

// A run tab and its session's lifetime are independent: hiding never touches the session, and an ended assistant tab
// comes back after a relaunch (localStorage) like a project's.
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k)
})

const summary = (id: string, projectId: string, status: string, startedAt: number): Record<string, unknown> => ({ id, projectId, kind: 'work', prompt: id, status, startedAt, totalCostUsd: 0 })
const record = (s: Record<string, unknown>): Record<string, unknown> => ({ summary: s, agents: {}, transcript: [], logs: [] })

const quickRows = [summary('c1', 'quick', 'finished', 1), summary('c2', 'quick', 'finished', 2)]
const api = {
  runs: {
    list: vi.fn(async (pid: string) => (pid === 'quick' ? quickRows : [])),
    get: vi.fn(async (id: string) => {
      const row = quickRows.find((r) => r.id === id)
      return row ? record(row) : null
    }),
    pendingCards: vi.fn(async () => []),
    stop: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined)
  },
  projects: { get: vi.fn(async () => null) }
}
vi.stubGlobal('window', { orgai: api, dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { hash: '' } })
vi.stubGlobal('Event', class {})
vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))

const { useAppStore, projectTabRuns, HIDDEN_LIVE_NOTICE } = await import('./useAppStore')

const run = (id: string, projectId: string, status: string, startedAt: number): unknown => ({
  summary: summary(id, projectId, status, startedAt),
  agents: {},
  transcript: [],
  permissions: [],
  proposals: [],
  questions: [],
  ruleRequests: [],
  mergeReviews: [],
  logs: [],
  partial: {},
  messages: [],
  mcpInstalls: [],
  mcpResolved: {}
})

beforeEach(() => {
  for (const fn of [...Object.values(api.runs), api.projects.get]) fn.mockClear()
  useAppStore.setState({ runs: {}, historyByProject: {}, history: [], dismissedRuns: {}, unreadByRun: {}, activeRunByProject: {}, draftPage: {}, tabNotice: null, selectedProjectId: null } as never)
})

describe('dismissRun: hiding a tab never touches the session', () => {
  it('hides a live tab, moves to its right neighbour and says the run keeps working', () => {
    useAppStore.setState({
      selectedProjectId: 'p1',
      runs: { a: run('a', 'p1', 'running', 1), b: run('b', 'p1', 'finished', 2) } as never,
      activeRunByProject: { p1: 'a' }
    })
    useAppStore.getState().dismissRun('a')
    const s = useAppStore.getState()
    expect(s.dismissedRuns.a).toBe(true)
    expect(s.activeRunByProject.p1).toBe('b')
    expect(s.runs.a.summary.status).toBe('running')
    expect(s.tabNotice).toBe(HIDDEN_LIVE_NOTICE)
    expect(projectTabRuns(s).map((r) => r.summary.id)).toEqual(['b'])
    expect(api.runs.stop).not.toHaveBeenCalled()
    expect(api.runs.interrupt).not.toHaveBeenCalled()
  })

  it('hiding the only tab (live, idle) opens the New run page; openRun brings it back un-hidden', async () => {
    useAppStore.setState({ selectedProjectId: 'p1', runs: { a: run('a', 'p1', 'idle', 1) } as never, activeRunByProject: { p1: 'a' } })
    useAppStore.getState().dismissRun('a')
    let s = useAppStore.getState()
    expect(s.draftPage.p1).toBe(true)
    expect(s.activeRunByProject.p1).toBeUndefined()
    expect(projectTabRuns(s)).toEqual([])
    useAppStore.setState({ projects: [{ id: 'p1', name: 'P', roles: [] }] as never })
    await useAppStore.getState().openRun('a')
    s = useAppStore.getState()
    expect(s.dismissedRuns.a).toBeUndefined()
    expect(s.activeRunByProject.p1).toBe('a')
    expect(s.draftPage.p1).toBeUndefined()
    expect(s.runs.a.summary.status).toBe('idle')
  })

  it('an ended tab still says "Find it in History"', () => {
    useAppStore.setState({ selectedProjectId: 'p1', runs: { a: run('a', 'p1', 'finished', 1) } as never, activeRunByProject: { p1: 'a' } })
    useAppStore.getState().dismissRun('a')
    expect(useAppStore.getState().tabNotice).toBe('Hidden. Find it in History.')
  })
})

describe('assistant tabs survive their session ending and a relaunch', () => {
  it('openAssistant restores the remembered ended tabs and opens the last viewed one, not the start page', async () => {
    storage.set('orgai.openTabs.quick', JSON.stringify({ chains: ['c1', 'c2'], viewed: 'c1' }))
    await useAppStore.getState().openAssistant('quick')
    await vi.waitFor(() => expect(useAppStore.getState().activeRunByProject.quick).toBe('c1'))
    const s = useAppStore.getState()
    expect(s.draftPage.quick).toBeUndefined()
    expect(projectTabRuns(s).map((r) => r.summary.id)).toEqual(['c1', 'c2'])
    // The watcher keeps writing the assistant's tabs once restored.
    useAppStore.getState().dismissRun('c2')
    await vi.waitFor(() => expect(JSON.parse(storage.get('orgai.openTabs.quick') ?? '{}')).toEqual({ chains: ['c1'], viewed: 'c1' }))
  })
})
