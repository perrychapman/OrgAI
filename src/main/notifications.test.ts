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
})
