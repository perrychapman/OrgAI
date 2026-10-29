import { app, BrowserWindow, Notification } from 'electron'
import type { FocusRunTarget, RunEvent, RunKind } from '@shared/types'
import { IPC } from '@shared/types'

export interface NotifierDeps {
  /** Project of a run, while the main process still knows the run. */
  projectOfRun(runId: string): { projectId: string; kind: RunKind } | undefined
  /** Display name of a project. */
  projectName(projectId: string): string | undefined
}

/**
 * OS attention notifications. Fed every broadcast RunEvent; shows a notification only when no
 * OrgAI window is focused and the event means the user is needed (a request, a turn that ended,
 * a run that finished or failed). Clicking one focuses the window and asks the renderer to show the run.
 */
export class Notifier {
  private enabled = true
  /** runId -> project, cached because the run manager forgets runs once they end. */
  private runs = new Map<string, { projectId: string; kind: RunKind }>()
  /** runId -> agentId -> display name, learned from agent.upsert events. */
  private agentNames = new Map<string, Map<string, string>>()
  /** Electron drops click handlers of notifications that get garbage collected; keep them alive. */
  private alive = new Set<Notification>()

  constructor(private deps: NotifierDeps) {
    if (process.platform === 'win32') app.setAppUserModelId('com.orgai.app')
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** Stop the taskbar flash once the user comes back. */
  attach(win: BrowserWindow): void {
    win.on('focus', () => {
      if (process.platform === 'win32' && !win.isDestroyed()) win.flashFrame(false)
    })
  }

  handle(event: RunEvent): void {
    if (event.type === 'project.updated') return
    const run = this.lookup(event.runId)
    if (event.type === 'agent.upsert') {
      let names = this.agentNames.get(event.runId)
      if (!names) this.agentNames.set(event.runId, (names = new Map()))
      names.set(event.agent.id, event.agent.name)
      return
    }
    if (event.type === 'run.status' && (event.status === 'finished' || event.status === 'error')) {
      this.agentNames.delete(event.runId)
    }

    const isRequest = event.type.endsWith('.request')
    const body = this.describe(event, run?.kind)
    if (!body || !run) return
    if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())) return

    if (isRequest && process.platform === 'win32') {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.flashFrame(true)
    }
    if (!this.enabled || !Notification.isSupported()) return

    const notification = new Notification({
      title: this.deps.projectName(run.projectId) ?? 'OrgAI',
      body,
      urgency: isRequest ? 'critical' : 'normal'
    })
    const target: FocusRunTarget = { projectId: run.projectId, runId: event.runId }
    const release = (): void => {
      this.alive.delete(notification)
    }
    notification.on('click', () => {
      release()
      this.focus(target)
    })
    notification.on('close', release)
    this.alive.add(notification)
    notification.show()
  }

  private lookup(runId: string): { projectId: string; kind: RunKind } | undefined {
    let run = this.runs.get(runId)
    if (!run) {
      run = this.deps.projectOfRun(runId)
      if (run) this.runs.set(runId, run)
    }
    return run
  }

  private agentName(runId: string, agentId: string): string {
    return this.agentNames.get(runId)?.get(agentId) ?? (agentId === 'root' ? 'The orchestrator' : 'An agent')
  }

  /** Notification body for events that need the user, or null for everything else. */
  private describe(event: RunEvent, kind: RunKind | undefined): string | null {
    const label = kind === 'setup' ? 'Setup session' : 'Run'
    switch (event.type) {
      case 'permission.request':
        return `${this.agentName(event.runId, event.request.agentId)} needs approval: ${event.request.summary}`.slice(0, 240)
      case 'proposal.request': {
        const what = event.proposal.kind === 'architecture' ? 'Architecture' : event.proposal.kind === 'orgChart' ? 'Org chart' : 'Settings'
        const title = event.proposal.title?.trim()
        return `Setup proposal: ${what}${title && title.toLowerCase() !== what.toLowerCase() ? ` - ${title}` : ''}`.slice(0, 240)
      }
      case 'run.status':
        if (event.status === 'idle') return kind === 'setup' ? 'The Architect is waiting for your answer' : 'Turn finished, waiting for your reply'
        if (event.status === 'paused')
          return event.autoResume
            ? `${label} paused at a usage limit; it continues at ${event.pausedUntil ? new Date(event.pausedUntil).toLocaleTimeString() : 'the reset'}`
            : null
        // A paused run handed over to its continuation is not news.
        if (event.status === 'finished' && event.pausedUntil) return null
        if (event.status === 'finished') return `${label} finished`
        if (event.status === 'error') return `${label} failed${event.error ? `: ${event.error}` : ''}`.slice(0, 240)
        return null
      default:
        // Any future request-style event still deserves attention.
        return event.type.endsWith('.request') ? `${label} needs your attention` : null
    }
  }

  private focus(target: FocusRunTarget): void {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (process.platform === 'win32') win.flashFrame(false)
    win.webContents.send(IPC.appFocusRun, target)
  }
}
