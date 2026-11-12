import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_MENU_STATE } from '@shared/types'

const store = {
  setView: vi.fn(),
  openDraft: vi.fn(),
  focusComposer: vi.fn(),
  closeDraft: vi.fn(),
  dismissRun: vi.fn(),
  setTabNotice: vi.fn(),
  interrupt: vi.fn(async () => undefined),
  stopRun: vi.fn(async () => undefined),
  jumpToDecision: vi.fn(async () => undefined),
  openAssistant: vi.fn(async () => undefined),
  selectProject: vi.fn(),
  requestTeamFilesFocus: vi.fn()
}

vi.stubGlobal('window', { orgai: { window: { openRun: vi.fn(async () => undefined) } }, dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
vi.stubGlobal('Event', class {})

const { useAppStore } = await import('../store/useAppStore')
const actions = await import('./menuActions')
const registry = await import('./menuRegistry')

type Partials = Record<string, unknown>

function run(id: string, projectId: string, status: string, extra: Partials = {}, summary: Partials = {}): unknown {
  return { summary: { id, projectId, status, startedAt: Number(id.replace(/\D/g, '')) || 1, ...summary }, ...extra }
}

function setState(p: Partials): void {
  useAppStore.setState({
    selectedProjectId: null,
    view: 'projects',
    projects: [],
    runs: {},
    activeRunByProject: {},
    draftPage: {},
    ...store,
    ...p
  } as never)
}

const PROJECTS = [{ id: 'p1', name: 'P' }]

beforeEach(() => {
  vi.useFakeTimers()
  registry.resetMenuRegistry()
  registry.installMenuRouter(actions.routeMenuAction)
  for (const fn of Object.values(store)) fn.mockClear()
  setState({})
})
afterEach(() => {
  vi.useRealTimers()
})

describe('routeMenuAction', () => {
  it('ignores unknown names and never throws', () => {
    expect(() => actions.routeMenuAction('rm-rf')).not.toThrow()
    expect(() => actions.routeMenuAction(undefined)).not.toThrow()
    expect(store.setView).not.toHaveBeenCalled()
  })

  it('a registered handler wins and its string is announced', () => {
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run' })
    const ok = vi.fn()
    const off = registry.registerMenuHandler('canvas-fit', ok)
    actions.routeMenuAction('canvas-fit')
    expect(ok).toHaveBeenCalledOnce()
    expect(store.setTabNotice).not.toHaveBeenCalled()
    off()
    registry.registerMenuHandler('canvas-fit', () => 'Nothing to fit.')
    actions.routeMenuAction('canvas-fit')
    expect(store.setTabNotice).toHaveBeenCalledWith('Nothing to fit.')
  })

  it('announces in the app-wide region when the run tabs are not on screen, and repeats', () => {
    actions.routeMenuAction('new-run')
    vi.advanceTimersByTime(100)
    expect(actions.currentMenuAnnouncement()).toBe('Open a project first.')
    actions.routeMenuAction('new-run')
    expect(actions.currentMenuAnnouncement()).toBe('')
    vi.advanceTimersByTime(100)
    expect(actions.currentMenuAnnouncement()).toBe('Open a project first.')
    vi.advanceTimersByTime(5000)
    expect(actions.currentMenuAnnouncement()).toBe('')
  })

  it('says why a section item does not apply', () => {
    actions.routeMenuAction('show-history')
    vi.advanceTimersByTime(100)
    expect(actions.currentMenuAnnouncement()).toBe('Open a project first.')
    setState({ selectedProjectId: 'quick', view: 'history' })
    actions.routeMenuAction('show-team')
    expect(store.setTabNotice).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(actions.currentMenuAnnouncement()).toBe('Assistants have no team or settings.')
  })

  it('new-run opens the draft page on a project', () => {
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'history' })
    actions.routeMenuAction('new-run')
    expect(store.setView).toHaveBeenCalledWith('run')
    expect(store.openDraft).toHaveBeenCalled()
    expect(store.focusComposer).toHaveBeenCalled()
  })

  it('interrupt and end session wording', () => {
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run' })
    actions.routeMenuAction('interrupt-run')
    expect(store.setTabNotice).toHaveBeenLastCalledWith('Open a run first.')
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', runs: { r1: run('r1', 'p1', 'idle') }, activeRunByProject: { p1: 'r1' } })
    actions.routeMenuAction('interrupt-run')
    expect(store.setTabNotice).toHaveBeenLastCalledWith('This run is not working right now.')
    actions.routeMenuAction('end-session')
    expect(store.stopRun).toHaveBeenCalled()
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', runs: { r1: run('r1', 'p1', 'finished') }, activeRunByProject: { p1: 'r1' } })
    actions.routeMenuAction('end-session')
    expect(store.setTabNotice).toHaveBeenLastCalledWith('This session has already ended.')
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', runs: { r1: run('r1', 'p1', 'running') }, activeRunByProject: { p1: 'r1' } })
    actions.routeMenuAction('interrupt-run')
    expect(store.interrupt).toHaveBeenCalled()
  })

  it('close-tab: draft page closes, finished run is hidden, working run stays', () => {
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', draftPage: { p1: true } })
    actions.routeMenuAction('close-tab')
    expect(store.closeDraft).toHaveBeenCalled()
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', runs: { r1: run('r1', 'p1', 'finished') }, activeRunByProject: { p1: 'r1' } })
    actions.routeMenuAction('close-tab')
    expect(store.dismissRun).toHaveBeenCalledWith('r1')
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', runs: { r1: run('r1', 'p1', 'running') }, activeRunByProject: { p1: 'r1' } })
    actions.routeMenuAction('close-tab')
    expect(store.setTabNotice).toHaveBeenLastCalledWith('A working run stays open. End its session first.')
    store.setTabNotice.mockClear()
    setState({})
    actions.routeMenuAction('close-tab')
    expect(store.setTabNotice).not.toHaveBeenCalled()
  })

  it('decisions: go-to-decision and show-needs-you', () => {
    const waiting = run('r2', 'p1', 'idle', { questions: [{ id: 'q1', question: 'Which?' }] })
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'history', runs: { r2: waiting }, activeRunByProject: { p1: 'r2' } })
    actions.routeMenuAction('go-to-decision')
    expect(store.jumpToDecision).toHaveBeenCalledWith('p1', 'r2', 'q1')
    store.jumpToDecision.mockClear()
    actions.routeMenuAction('show-needs-you')
    expect(store.jumpToDecision).toHaveBeenCalledWith('p1', 'r2', 'q1')
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'history' })
    actions.routeMenuAction('go-to-decision')
    vi.advanceTimersByTime(100)
    expect(actions.currentMenuAnnouncement()).toBe('No decision is waiting on this run.')
    actions.routeMenuAction('show-needs-you')
    vi.advanceTimersByTime(100)
    expect(actions.currentMenuAnnouncement()).toBe('Nothing needs you right now.')
  })

  it('team-files approvals count as a decision and open the Team tab', () => {
    const teamFilesByProject = { p1: { projectId: 'p1', projectName: 'P', state: 'pending', changes: [{ needsApproval: true }], problems: [] } }
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'history', teamFilesByProject })
    expect(actions.menuStateFor(useAppStore.getState()).hasDecision).toBe(true)
    actions.routeMenuAction('go-to-decision')
    expect(store.setView).toHaveBeenCalledWith('team')
    expect(store.requestTeamFilesFocus).toHaveBeenCalledWith('p1')
    store.setView.mockClear()
    // No project selected: go-to-decision falls back to the first team item.
    setState({ selectedProjectId: null, projects: PROJECTS, view: 'projects', teamFilesByProject })
    actions.routeMenuAction('go-to-decision')
    expect(store.requestTeamFilesFocus).toHaveBeenLastCalledWith('p1')
    store.setView.mockClear()
    setState({ selectedProjectId: null, projects: PROJECTS, view: 'projects', teamFilesByProject })
    actions.routeMenuAction('show-needs-you')
    expect(store.selectProject).toHaveBeenCalledWith('p1')
    expect(store.setView).toHaveBeenCalledWith('team')
  })

  it('screen-only actions fall back to a sentence', () => {
    setState({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run' })
    actions.routeMenuAction('canvas-zoom-in')
    expect(store.setTabNotice).toHaveBeenLastCalledWith('Open a run on Live to use the canvas.')
    actions.routeMenuAction('org-retrospective')
    expect(store.setTabNotice).toHaveBeenLastCalledWith('Not available for this run.')
    actions.routeMenuAction('open-run-window')
    expect(store.setTabNotice).toHaveBeenLastCalledWith('Open a run first.')
  })

  it('keyboard-shortcuts opens the dialog flag', () => {
    actions.closeKeyboardShortcuts()
    actions.routeMenuAction('keyboard-shortcuts')
    expect(actions.isKeyboardShortcutsOpen()).toBe(true)
    actions.closeKeyboardShortcuts()
  })
})

describe('menuStateFor', () => {
  const base = { selectedProjectId: null, view: 'projects', projects: [], runs: {}, activeRunByProject: {}, draftPage: {} } as never
  const src = (p: Partials): never => ({ ...(base as object), ...p }) as never

  it('is empty with no project', () => {
    expect(actions.menuStateFor(base)).toEqual(EMPTY_MENU_STATE)
  })
  it('has a project but no run on the draft page', () => {
    const s = actions.menuStateFor(src({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', draftPage: { p1: true }, runs: { r1: run('r1', 'p1', 'running') }, activeRunByProject: { p1: 'r1' } }))
    expect(s).toEqual({ ...EMPTY_MENU_STATE, hasProject: true })
  })
  it('live run', () => {
    const s = actions.menuStateFor(src({ selectedProjectId: 'p1', projects: PROJECTS, view: 'run', runs: { r1: run('r1', 'p1', 'running') }, activeRunByProject: { p1: 'r1' } }))
    expect(s).toEqual({ hasProject: true, hasRun: true, runLive: true, chatRun: false, hasDecision: false })
  })
  it('ended Chat run', () => {
    const s = actions.menuStateFor(src({ selectedProjectId: 'quick', view: 'run', runs: { r1: run('r1', 'quick', 'finished', {}, { quick: true }) }, activeRunByProject: { quick: 'r1' } }))
    expect(s).toEqual({ hasProject: true, hasRun: true, runLive: false, chatRun: true, hasDecision: false })
  })
  it('a waiting decision anywhere', () => {
    const waiting = run('r2', 'p2', 'idle', { questions: [{ id: 'q1', question: 'x' }] })
    const s = actions.menuStateFor(src({ selectedProjectId: 'p1', projects: PROJECTS, view: 'history', runs: { r2: waiting } }))
    expect(s).toEqual({ ...EMPTY_MENU_STATE, hasProject: true, hasDecision: true })
  })
  it('app settings view has no project', () => {
    expect(actions.menuStateFor(src({ selectedProjectId: 'p1', projects: PROJECTS, view: 'appSettings' })).hasProject).toBe(false)
  })
})

describe('menuStateChanged', () => {
  it('compares the five booleans', () => {
    expect(actions.menuStateChanged(EMPTY_MENU_STATE, { ...EMPTY_MENU_STATE })).toBe(false)
    expect(actions.menuStateChanged(EMPTY_MENU_STATE, { ...EMPTY_MENU_STATE, runLive: true })).toBe(true)
  })
})

describe('shared tables and Ask OrgAI', () => {
  it('SHORTCUTS is the shared table', async () => {
    const shared = await import('@shared/view/shortcuts')
    expect(actions.SHORTCUTS).toBe(shared.SHORTCUTS)
  })
  it('ask-about-orgai opens a fresh Chat with the seed and focuses the composer', async () => {
    actions.routeMenuAction('ask-about-orgai')
    await vi.runAllTimersAsync()
    expect(store.openAssistant).toHaveBeenCalledWith('quick', { instruction: actions.ASK_ORGAI_SEED, fresh: true })
    expect(store.focusComposer).toHaveBeenCalled()
  })
})

describe('usageMenuAnnouncement', () => {
  const projects = [{ id: 'p1', name: 'Billing' }]
  it('names the narrowing the page keeps', () => {
    expect(actions.usageMenuAnnouncement({ usageFilters: { projectIds: [] }, projects })).toBe('Usage, all projects.')
    expect(actions.usageMenuAnnouncement({ usageFilters: { projectIds: ['p1'] }, projects })).toBe('Usage, Billing.')
    expect(actions.usageMenuAnnouncement({ usageFilters: { projectIds: ['quick'] }, projects })).toBe('Usage, Chat.')
    expect(actions.usageMenuAnnouncement({ usageFilters: { projectIds: ['p1', 'p2'] }, projects })).toBe('Usage, 2 projects.')
  })
})

describe('shortcuts', () => {
  it('names Ctrl or Cmd', () => {
    expect(actions.keyLabel('Mod', false)).toBe('Ctrl')
    expect(actions.keyLabel('Mod', true)).toBe('Cmd')
    expect(actions.SHORTCUTS.every((s) => s.combos.length > 0)).toBe(true)
  })
})
