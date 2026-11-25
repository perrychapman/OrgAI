import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'

const shown: { title: string; body: string }[] = []
const icons: (string | undefined)[] = []
const flashes: boolean[] = []
const clicks: (() => void)[] = []
const bounces: string[] = []
const direct: string[] = []
const wins = [
  {
    isDestroyed: () => false,
    isFocused: () => false,
    isMinimized: () => false,
    flashFrame: (f: boolean) => flashes.push(f),
    on: () => {},
    show: () => direct.push('show'),
    focus: () => direct.push('focus'),
    webContents: { send: () => {} }
  }
]

vi.mock('electron', () => {
  class Notification {
    static isSupported(): boolean {
      return true
    }
    constructor(private opts: { title: string; body: string; icon?: string }) {}
    on(event: string, fn: () => void): void {
      if (event === 'click') clicks.push(fn)
    }
    show(): void {
      if ('icon' in this.opts) icons.push(this.opts.icon)
      shown.push({ title: this.opts.title, body: this.opts.body })
    }
  }
  return {
    app: { setAppUserModelId: () => {}, dock: { bounce: (kind: string) => bounces.push(kind) } },
    // No focused window, so every attention event is eligible.
    BrowserWindow: { getAllWindows: () => wins },
    Notification
  }
})

const { Notifier } = await import('./notifications')

const request: RunEvent = {
  type: 'permission.request',
  runId: 'run-1',
  request: { id: 'p1', runId: 'run-1', agentId: 'root', toolName: 'Edit', input: {}, summary: 'Editing a.ts', ruleLabels: [] } as never
}

describe('Notifier', () => {
  beforeEach(() => {
    shown.length = 0
    icons.length = 0
  })

  it('reads AppSettings.notifications at every decision, so a save takes effect at once', () => {
    const settings = { notifications: true as boolean | undefined }
    const notifier = new Notifier({
      projectOfRun: () => ({ projectId: 'proj', kind: 'work' }),
      projectName: () => 'Shop',
      enabled: () => settings.notifications !== false
    })
    notifier.handle(request)
    expect(shown).toEqual([{ title: 'Shop', body: 'The orchestrator needs approval: Editing a.ts' }])

    settings.notifications = false
    notifier.handle(request)
    expect(shown).toHaveLength(1)

    settings.notifications = undefined // settings saved before the field existed: on
    notifier.handle(request)
    expect(shown).toHaveLength(2)
  })

  it('ORGAI_QUIET (the quiet dep) shows no notification and no taskbar flash, for events and notices; off is unchanged', () => {
    const deps = { projectOfRun: () => ({ projectId: 'proj', kind: 'work' as const }), projectName: () => 'Shop', enabled: () => true }
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      flashes.length = 0
      const loud = new Notifier({ ...deps, quiet: false })
      loud.handle(request)
      loud.notice({ title: 'Schedule paused', body: 'Nightly stopped' })
      expect(shown.map((s) => s.title)).toEqual(['Shop', 'Schedule paused'])
      expect(flashes).toEqual([true])

      shown.length = 0
      flashes.length = 0
      const quiet = new Notifier({ ...deps, quiet: true })
      quiet.handle(request)
      quiet.handle({ type: 'run.status', runId: 'run-1', status: 'finished' })
      quiet.notice({ title: 'Schedule paused', body: 'Nightly stopped' })
      expect(shown).toEqual([])
      expect(flashes).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  it('ORGAI_QUIET suppresses the macOS Dock bounce; loud bounces once for a request', () => {
    const deps = { projectOfRun: () => ({ projectId: 'proj', kind: 'work' as const }), projectName: () => 'Shop', enabled: () => true }
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      bounces.length = 0
      new Notifier({ ...deps, quiet: false }).handle(request)
      expect(bounces).toEqual(['critical'])
      bounces.length = 0
      new Notifier({ ...deps, quiet: true }).handle(request)
      expect(bounces).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  it('a notification click reveals the window through the reveal dep (run and notice paths), else shows and focuses directly', () => {
    const deps = { projectOfRun: () => ({ projectId: 'proj', kind: 'work' as const }), projectName: () => 'Shop', enabled: () => true }
    const revealed: unknown[] = []
    clicks.length = 0
    direct.length = 0
    const withDep = new Notifier({ ...deps, reveal: (w) => revealed.push(w) })
    withDep.handle(request)
    withDep.notice({ title: 'Schedule paused', body: 'x' })
    expect(clicks).toHaveLength(2)
    for (const click of clicks) click()
    expect(revealed).toEqual([wins[0], wins[0]])
    expect(direct).toEqual([])

    clicks.length = 0
    const without = new Notifier(deps)
    without.handle(request)
    clicks[0]!()
    expect(direct).toEqual(['show', 'focus'])
  })

  it('passes the icon path on Linux only', () => {
    const make = (): InstanceType<typeof Notifier> =>
      new Notifier({ projectOfRun: () => ({ projectId: 'proj', kind: 'work' }), projectName: () => 'Shop', enabled: () => true, iconPath: () => '/res/icon.png' })
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      make().handle(request)
      expect(icons).toEqual(['/res/icon.png'])
      icons.length = 0
      Object.defineProperty(process, 'platform', { value: 'win32' })
      make().handle(request)
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      make().handle(request)
      expect(icons).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  it('labels a harness MCP assistant run with the app name and its own wording', () => {
    const notifier = new Notifier({
      projectOfRun: () => ({ projectId: 'harness', kind: 'mcp-assist' }),
      projectName: (id) => (id === 'harness' ? 'OrgAI' : undefined),
      enabled: () => true
    })
    notifier.handle({
      type: 'proposal.request',
      runId: 'run-1',
      proposal: { id: 'pr', runId: 'run-1', agentId: 'root', kind: 'mcpServers', title: 'Add GitHub', payload: {}, createdAt: 0 } as never
    })
    notifier.handle({ type: 'run.status', runId: 'run-1', status: 'finished' })
    expect(shown).toEqual([
      { title: 'OrgAI', body: 'MCP proposal: MCP servers - Add GitHub' },
      { title: 'OrgAI', body: 'MCP assistant session finished' }
    ])
  })

  it('labels Skill assistant sessions and skills proposals', () => {
    const notifier = new Notifier({
      projectOfRun: () => ({ projectId: 'skills', kind: 'skill-assist' }),
      projectName: (id) => (id === 'skills' ? 'Skill assistant' : undefined),
      enabled: () => true
    })
    notifier.handle({
      type: 'proposal.request',
      runId: 'run-1',
      proposal: { id: 'pr', runId: 'run-1', agentId: 'root', kind: 'skills', title: 'Add release-notes', payload: {}, createdAt: 0 } as never
    })
    notifier.handle({ type: 'run.status', runId: 'run-1', status: 'error', error: 'boom' })
    expect(shown).toEqual([
      { title: 'Skill assistant', body: 'Skill proposal: Skills - Add release-notes' },
      { title: 'Skill assistant', body: 'Skill assistant session failed: boom' }
    ])
  })

  describe('per-event switches under the master one', () => {
    const on = { needsMe: true, runFinished: true, scheduleFindings: true }
    const make = (switches: typeof on, master = true): InstanceType<typeof Notifier> =>
      new Notifier({
        projectOfRun: () => ({ projectId: 'proj', kind: 'work' }),
        projectName: () => 'Shop',
        enabled: () => master,
        categoryEnabled: (c) => switches[c]
      })
    const idle: RunEvent = { type: 'run.status', runId: 'run-1', status: 'idle' }
    const finished: RunEvent = { type: 'run.status', runId: 'run-1', status: 'finished' }
    const failed: RunEvent = { type: 'run.status', runId: 'run-1', status: 'error', error: 'boom' }
    const planBlocked = { type: 'plan.updated', runId: 'run-1', plan: { goal: 'g', status: 'blocked', blockedReason: 'stuck', steps: [], autoContinues: 0 } } as unknown as RunEvent
    const planDone = { type: 'plan.updated', runId: 'run-1', plan: { goal: 'g', status: 'done', summary: 'all done', steps: [], autoContinues: 0 } } as unknown as RunEvent

    it('notifyNeedsMe off silences requests, waiting turns and a blocked plan, not run ends', () => {
      const n = make({ ...on, needsMe: false })
      for (const e of [request, idle, planBlocked]) n.handle(e)
      expect(shown).toEqual([])
      n.handle(finished)
      n.handle(failed)
      n.handle(planDone)
      expect(shown.map((s) => s.body)).toEqual(['Run finished', 'Run failed: boom', 'Plan complete: all done'])
    })

    it('notifyRunFinished off silences finished, failed and completed-plan notices, not requests', () => {
      const n = make({ ...on, runFinished: false })
      for (const e of [finished, failed, planDone]) n.handle(e)
      expect(shown).toEqual([])
      n.handle(request)
      n.handle(idle)
      expect(shown).toHaveLength(2)
    })

    it('notifyScheduleFindings off silences Schedules notices only', () => {
      const n = make({ ...on, scheduleFindings: false })
      n.notice({ title: 'Schedule "Nightly" paused', body: 'It failed.' })
      expect(shown).toEqual([])
      n.handle(finished)
      expect(shown).toHaveLength(1)
      const all = make(on)
      all.notice({ title: 'Schedule "Nightly" paused', body: 'It failed.' })
      expect(shown).toHaveLength(2)
    })

    it('the master switch still wins, and no categoryEnabled means every category is on', () => {
      make(on, false).notice({ title: 't', body: 'b' })
      make(on, false).handle(request)
      expect(shown).toEqual([])
      const plain = new Notifier({ projectOfRun: () => ({ projectId: 'proj', kind: 'work' }), projectName: () => 'Shop', enabled: () => true })
      plain.handle(request)
      plain.handle(finished)
      plain.notice({ title: 't', body: 'b' })
      expect(shown).toHaveLength(3)
    })
  })

  it('names a Chat run "Chat" where the location is named', () => {
    const notifier = new Notifier({
      projectOfRun: () => ({ projectId: 'quick', kind: 'work' }),
      projectName: (id) => (id === 'quick' ? 'Chat' : undefined),
      enabled: () => true
    })
    notifier.handle({ type: 'run.status', runId: 'run-1', status: 'finished' })
    expect(shown).toEqual([{ title: 'Chat', body: 'Chat finished' }])
  })
})
