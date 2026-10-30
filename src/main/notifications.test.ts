import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'

const shown: { title: string; body: string }[] = []

vi.mock('electron', () => {
  class Notification {
    static isSupported(): boolean {
      return true
    }
    constructor(private opts: { title: string; body: string }) {}
    on(): void {}
    show(): void {
      shown.push({ title: this.opts.title, body: this.opts.body })
    }
  }
  return {
    app: { setAppUserModelId: () => {}, dock: undefined },
    // No focused window, so every attention event is eligible.
    BrowserWindow: { getAllWindows: () => [] },
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
})
