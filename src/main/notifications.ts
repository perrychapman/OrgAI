import { app, BrowserWindow, Notification } from 'electron'
import type { FocusRunTarget, RunEvent, RunKind, RunPlan } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES, IPC } from '@shared/types'

/** What the notifier knows about a run. */
export interface NotifierRun {
  projectId: string
  kind: RunKind
  /** The project keeps the orchestrator going while its plan is active (no "turn finished" noise then). */
  autoContinue?: boolean
  /** The project's automatic-continue limit; at the limit a finished turn notifies again. */
  maxAutoContinues?: number
}

export interface NotifierDeps {
  /** Project of a run, while the main process still knows the run. */
  projectOfRun(runId: string): NotifierRun | undefined
  /** Display name of a project. */
  projectName(projectId: string): string | undefined
  /**
   * Whether OS notifications are on, read at every decision. index.ts passes
   * `() => settings.get().notifications !== false`, so AppSettings.notifications is the single source of truth
   * and a save takes effect at once.
   */
  enabled(): boolean
}

/**
 * OS attention notifications. Fed every broadcast RunEvent; shows a notification only when no
 * OrgAI window is focused and the event means the user is needed (a request, a turn that ended,
 * a run that finished or failed). Clicking one focuses the window and asks the renderer to show the run.
 */
export class Notifier {
  /** runId -> project, cached because the run manager forgets runs once they end. */
  private runs = new Map<string, NotifierRun>()
  /** runId -> latest plan, from plan.updated events. */
  private plans = new Map<string, RunPlan>()
  /** runId -> agentId -> display name, learned from agent.upsert events. */
  private agentNames = new Map<string, Map<string, string>>()
  /** Electron drops click handlers of notifications that get garbage collected; keep them alive. */
  private alive = new Set<Notification>()

  constructor(private deps: NotifierDeps) {
    if (process.platform === 'win32') app.setAppUserModelId('com.orgai.app')
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
      this.plans.delete(event.runId)
    }
    let planChange: RunPlan['status'] | null = null
    if (event.type === 'plan.updated') {
      const before = this.plans.get(event.runId)?.status
      this.plans.set(event.runId, event.plan)
      if (before !== event.plan.status && event.plan.status !== 'active') planChange = event.plan.status
    }

    const isRequest = event.type.endsWith('.request') || planChange === 'blocked'
    const body = event.type === 'plan.updated' ? this.describePlan(event.plan, planChange) : this.describe(event, run)
    if (!body || !run) return
    if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())) return

    if (isRequest && process.platform === 'win32') {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.flashFrame(true)
    }
    // macOS: bounce the Dock icon until the user returns (no-op when the app is frontmost, which we ruled out above).
    if (isRequest && process.platform === 'darwin') app.dock?.bounce('critical')
    // macOS shows notifications only after the user allows them (System Settings > Notifications > OrgAI). An
    // unsigned or ad-hoc build may be listed under Electron or not at all; a signed build is reliable.
    if (!this.deps.enabled() || !Notification.isSupported()) return

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

  private lookup(runId: string): NotifierRun | undefined {
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

  /** A plan that just finished or got blocked, like a finished run; null otherwise. */
  private describePlan(plan: RunPlan, change: RunPlan['status'] | null): string | null {
    if (change === 'done') return `Plan complete: ${plan.summary ?? plan.goal}`.slice(0, 240)
    if (change === 'blocked') return `The orchestrator needs you: ${plan.blockedReason ?? 'the plan is blocked'}`.slice(0, 240)
    return null
  }

  /** Notification body for events that need the user, or null for everything else. */
  private describe(event: RunEvent, run: NotifierRun | undefined): string | null {
    const kind = run?.kind
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
        if (event.status === 'idle') {
          // An active plan keeps going on its own; the user hears about it when it completes or blocks.
          const plan = this.plans.get(event.runId)
          const continues = kind === 'work' && run?.autoContinue !== false && plan?.status === 'active'
          if (continues && plan.autoContinues < (run?.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES)) return null
          return kind === 'setup' ? 'The Architect is waiting for your answer' : 'Turn finished, waiting for your reply'
        }
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
