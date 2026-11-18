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
// A second window's assistant: s1 was the last viewed tab elsewhere; s3 continues s2 (a chain of two) and loads slowly.
const skillsRows = [summary('s1', 'skills', 'finished', 1), summary('s2', 'skills', 'finished', 2), { ...summary('s3', 'skills', 'idle', 3), resumedFrom: 's2' }]
const api = {
  runs: {
    list: vi.fn(async (pid: string) => (pid === 'quick' ? quickRows : pid === 'skills' ? skillsRows : pid === 'ghost' ? [summary('g1', 'ghost', 'finished', 1)] : [])),
    get: vi.fn(async (id: string) => {
      if (id === 's2') await new Promise((resolve) => setTimeout(resolve, 60))
      const row = [...quickRows, ...skillsRows].find((r) => r.id === id)
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

const { useAppStore, projectTabRuns, HIDDEN_LIVE_NOTICE, HIDDEN_IDLE_NOTICE, hiddenLiveNotice, otherRunsHeading } = await import('./useAppStore')

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

  it('an idle live run says its session stays open, not that it keeps working', () => {
    useAppStore.setState({ selectedProjectId: 'p1', runs: { a: run('a', 'p1', 'idle', 1), b: run('b', 'p1', 'finished', 2) } as never, activeRunByProject: { p1: 'a' } })
    useAppStore.getState().dismissRun('a')
    expect(useAppStore.getState().tabNotice).toBe('Hidden. Its session stays open: find it in the sidebar or History.')
    expect(hiddenLiveNotice('running')).toBe(HIDDEN_LIVE_NOTICE)
    expect(hiddenLiveNotice('starting')).toBe(HIDDEN_LIVE_NOTICE)
    expect(hiddenLiveNotice('stopping')).toBe(HIDDEN_IDLE_NOTICE)
  })

  it('New run page heading names runs that need the user', () => {
    expect(otherRunsHeading(1, 0)).toBe('1 other run keeps going')
    expect(otherRunsHeading(3, 0)).toBe('3 other runs keep going')
    expect(otherRunsHeading(1, 1)).toBe('1 other run needs you')
    expect(otherRunsHeading(2, 1)).toBe('2 other runs keep going, 1 needs you')
    expect(otherRunsHeading(2, 2)).toBe('2 other runs need you')
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

  it('two hides in a row announce both times through setTabNotice, and no stray timer clears the second', () => {
    vi.useFakeTimers()
    try {
      useAppStore.setState({ selectedProjectId: 'p1', runs: { a: run('a', 'p1', 'running', 1), b: run('b', 'p1', 'running', 2), c: run('c', 'p1', 'finished', 3) } as never, activeRunByProject: { p1: 'c' } })
      const spy = vi.spyOn(useAppStore.getState(), 'setTabNotice')
      useAppStore.getState().dismissRun('a')
      expect(spy).toHaveBeenCalledWith(HIDDEN_LIVE_NOTICE)
      expect(useAppStore.getState().tabNotice).toBe(HIDDEN_LIVE_NOTICE)
      vi.advanceTimersByTime(3000)
      useAppStore.getState().dismissRun('b')
      expect(spy).toHaveBeenCalledTimes(2)
      // Same text again: cleared first, then set again so the status region reads it again.
      expect(useAppStore.getState().tabNotice).toBeNull()
      vi.advanceTimersByTime(100)
      expect(useAppStore.getState().tabNotice).toBe(HIDDEN_LIVE_NOTICE)
      // The first hide's 4 s timer fires here and must not clear the second notice.
      vi.advanceTimersByTime(3900)
      expect(useAppStore.getState().tabNotice).toBe(HIDDEN_LIVE_NOTICE)
      vi.advanceTimersByTime(500)
      expect(useAppStore.getState().tabNotice).toBeNull()
      spy.mockRestore()
      // Hiding an unknown run says nothing.
      useAppStore.getState().dismissRun('nope')
      vi.advanceTimersByTime(200)
      expect(useAppStore.getState().tabNotice).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an ended tab still says "Find it in History"', () => {
    useAppStore.setState({ selectedProjectId: 'p1', runs: { a: run('a', 'p1', 'finished', 1) } as never, activeRunByProject: { p1: 'a' } })
    useAppStore.getState().dismissRun('a')
    expect(useAppStore.getState().tabNotice).toBe('Hidden. Find it in History.')
  })
})

describe('re-entering a project', () => {
  it('stays on the New run page after every tab was hidden, and keeps the hidden live run hidden', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: 'P', roles: [] }] as never, selectedProjectId: 'p1', runs: { a: run('a', 'p1', 'idle', 1) } as never, activeRunByProject: { p1: 'a' } })
    useAppStore.getState().dismissRun('a')
    expect(useAppStore.getState().draftPage.p1).toBe(true)
    await useAppStore.getState().openProject('p1')
    const s = useAppStore.getState()
    expect(s.draftPage.p1).toBe(true)
    expect(s.dismissedRuns.a).toBe(true)
    expect(s.activeRunByProject.p1).toBeUndefined()
  })

  it('a hidden run is skipped by the fallbacks but a run that needs you still opens', async () => {
    const { defaultRunToOpen } = await import('../../../shared/view/needsYou')
    const live = [run('a', 'p1', 'running', 1), run('b', 'p1', 'running', 2)] as never[]
    expect(defaultRunToOpen(live, [], undefined, { hidden: { b: true } })).toBe('a')
    expect(defaultRunToOpen(live, [], undefined, { hidden: { a: true, b: true } })).toBeUndefined()
    expect(defaultRunToOpen(live, [{ id: 'h', startedAt: 0 }], 'b', { hidden: { a: true, b: true } })).toBe('h')
    expect(defaultRunToOpen(live, [], undefined, { startPage: true })).toBeUndefined()
    const asking = { ...(run('b', 'p1', 'running', 2) as object), permissions: [{ id: 'x', agentId: 'root', toolName: 'Bash' }] } as never
    expect(defaultRunToOpen([live[0], asking], [], undefined, { hidden: { b: true }, startPage: true })).toBe('b')
  })

  it('shows the New run page when a run known only from history fails to load', async () => {
    useAppStore.setState({ projects: [{ id: 'ghost', name: 'G', roles: [] }] as never })
    await useAppStore.getState().openProject('ghost')
    const s = useAppStore.getState()
    expect(s.runs.g1).toBeUndefined()
    expect(s.draftPage.ghost).toBe(true)
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

  it('a window opened for one run keeps it: the first settle never swaps in the tab another window remembered', async () => {
    // Another window left s1 as its viewed tab; this window opens s3, a chain whose earlier member loads slowly. The
    // first settle of the assistant used to finish before focusRun showed s3 and opened s1 over it.
    storage.set('orgai.openTabs.skills', JSON.stringify({ chains: ['s1'], viewed: 's1' }))
    await useAppStore.getState().focusRun('skills', 's3')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const s = useAppStore.getState()
    expect(s.activeRunByProject.skills).toBe('s3')
    expect(s.draftPage.skills).toBeUndefined()
    expect(s.runs.s3).toBeDefined()
  })

  it('a seeded entry stays on the start page however late the history and the remembered tabs settle', async () => {
    storage.set('orgai.openTabs.quick', JSON.stringify({ chains: ['c1', 'c2'], viewed: 'c2' }))
    const slow = api.runs.list.getMockImplementation()!
    api.runs.list.mockImplementation(async (pid: string) => { await new Promise((resolve) => setTimeout(resolve, 80)); return slow(pid) })
    try {
      await useAppStore.getState().openAssistant('quick', { instruction: 'How do I ', fresh: true })
      await new Promise((resolve) => setTimeout(resolve, 250))
      const s = useAppStore.getState()
      expect(s.draftPage.quick).toBe(true)
      expect(s.activeRunByProject.quick).toBeUndefined()
      expect(s.assistantSeed.quick).toBe('How do I ')
    } finally {
      api.runs.list.mockImplementation(slow)
    }
  })

  it('a named run that cannot load falls back to the start page instead of a blank workspace', async () => {
    await useAppStore.getState().focusRun('harness', 'gone')
    await vi.waitFor(() => expect(useAppStore.getState().draftPage.harness).toBe(true))
    expect(useAppStore.getState().activeRunByProject.harness).toBeUndefined()
  })
})
