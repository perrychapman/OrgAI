/**
 * App behaviour settings that reach the operating system (UI overhaul, General / Limits). Electron-free: index.ts
 * passes the real `app` / `powerSaveBlocker` calls, the unit tests pass fakes.
 *
 * - openAtLogin: applied at startup and when the setting changes, only on Windows and macOS and only in a packaged
 *   build. It is written only when the value differs from what the OS reports. At startup a setting that is off never
 *   removes an existing login entry (it may be the user's own); turning the setting off in the app does.
 * - keepAwakeDuringRuns: one powerSaveBlocker('prevent-app-suspension') while the setting is on and `liveRuns()` is above
 *   zero; released when the runs end or the setting goes off. Run events only schedule a re-check (debounced), so a
 *   streaming run costs nothing.
 * - closeBehavior: `closeActionFor` maps the last-window decision of hostLifecycle.ts. 'quit' changes nothing.
 */

import type { WindowAllClosedAction } from './hostLifecycle'

/** The slice of AppSettings this module reads (read fresh at every decision). */
export interface AppBehaviourSettings {
  openAtLogin?: boolean
  keepAwakeDuringRuns?: boolean
  closeBehavior?: 'quit' | 'keepRunning'
}

export interface AppBehaviourDeps {
  platform: NodeJS.Platform | string
  /** app.isPackaged: a login item for an unpackaged build would start the bare Electron binary. */
  packaged: boolean
  /** A Windows portable build runs from a temporary folder: its path is no good for a login item. */
  portable?: boolean
  settings(): AppBehaviourSettings
  /** Live runs that count for keep-awake (index.ts: RunManager.workingRunCount). */
  liveRuns(): number
  /** app.getLoginItemSettings().openAtLogin / app.setLoginItemSettings({ openAtLogin }). */
  loginItem: { get(): boolean; set(openAtLogin: boolean): void }
  /** electron's powerSaveBlocker. */
  powerBlocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): void; isStarted(id: number): boolean }
  log: { info(message: string): void; warn(message: string): void }
  /** Test seams. */
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  /** Delay between a run event and the keep-awake re-check. Default 500 ms. */
  recheckMs?: number
}

export const LOGIN_ITEM_PLATFORMS: readonly string[] = ['win32', 'darwin']

/**
 * The last window closed: with closeBehavior 'keepRunning' a decision that would ask the user (runs working without
 * them, or schedules due) goes to the background without asking. 'quit' (the default) and every other decision
 * (nothing live: quit; macOS: stay) are unchanged.
 */
export function closeActionFor(action: WindowAllClosedAction, closeBehavior: AppBehaviourSettings['closeBehavior']): WindowAllClosedAction | 'background' {
  return action === 'ask' && closeBehavior === 'keepRunning' ? 'background' : action
}

export class AppBehaviour {
  private blocker: number | undefined
  private timer: unknown
  /** The openAtLogin value last applied or seen at a settings change (undefined before start). */
  private lastLogin: boolean | undefined
  /** Dev / unsupported notices are logged once per value. */
  private loggedSkip: boolean | undefined
  private disposed = false

  constructor(private deps: AppBehaviourDeps) {}

  /** Once at startup, after the settings are loaded. */
  start(): void {
    this.applyLogin(true)
    this.recheck()
  }

  /** A settings save (SettingsStore.onChange). */
  settingsChanged(): void {
    if (this.disposed) return
    this.applyLogin(false)
    this.recheck()
  }

  /** Any run event: re-check keep-awake soon, but only when it can matter. */
  runEvent(): void {
    if (this.disposed) return
    if (this.blocker === undefined && this.deps.settings().keepAwakeDuringRuns !== true) return
    if (this.timer !== undefined) return
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
    this.timer = set(() => {
      this.timer = undefined
      this.recheck()
    }, this.deps.recheckMs ?? 500)
  }

  /** Quit: drop the timer and the blocker. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer)
    this.timer = undefined
    this.release('shutting down')
  }

  /** Whether the keep-awake blocker is held (tests, diagnostics). */
  get keepingAwake(): boolean {
    return this.blocker !== undefined
  }

  private recheck(): void {
    if (this.disposed) return
    let live = 0
    try {
      live = this.deps.settings().keepAwakeDuringRuns === true ? this.deps.liveRuns() : 0
    } catch (e) {
      this.deps.log.warn(`Keep-awake could not count live runs: ${e instanceof Error ? e.message : String(e)}`)
    }
    const want = live > 0
    // A blocker the OS dropped on its own counts as released.
    if (this.blocker !== undefined && !this.safe(() => this.deps.powerBlocker.isStarted(this.blocker as number), false)) this.blocker = undefined
    if (want && this.blocker === undefined) {
      try {
        this.blocker = this.deps.powerBlocker.start('prevent-app-suspension')
        this.deps.log.info(`Keeping the computer awake while ${live} run${live === 1 ? ' is' : 's are'} working.`)
      } catch (e) {
        this.deps.log.warn(`Keep-awake could not start: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else if (!want && this.blocker !== undefined) {
      this.release(this.deps.settings().keepAwakeDuringRuns === true ? 'no run is working' : 'the setting is off')
    }
  }

  private release(why: string): void {
    if (this.blocker === undefined) return
    const id = this.blocker
    this.blocker = undefined
    try {
      this.deps.powerBlocker.stop(id)
      this.deps.log.info(`Keep-awake released (${why}).`)
    } catch (e) {
      this.deps.log.warn(`Keep-awake could not be released: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private applyLogin(initial: boolean): void {
    const desired = this.deps.settings().openAtLogin === true
    const previous = this.lastLogin
    if (!LOGIN_ITEM_PLATFORMS.includes(this.deps.platform)) {
      this.lastLogin = desired
      if (desired && this.loggedSkip !== desired) this.skip(desired, `not supported on ${this.deps.platform}`)
      return
    }
    // Startup with the setting off leaves the OS alone; a later change (either way) is written.
    if (initial && !desired) {
      this.lastLogin = desired
      return
    }
    if (!initial && previous === desired) {
      // Unchanged, but a write that failed earlier is retried (lastLogin is only set once it worked or was skipped).
      return
    }
    if (!this.deps.packaged || this.deps.portable) {
      this.lastLogin = desired
      this.skip(desired, this.deps.portable ? 'a portable build has no stable path' : 'this is not a packaged build')
      return
    }
    try {
      if (this.deps.loginItem.get() !== desired) {
        this.deps.loginItem.set(desired)
        this.deps.log.info(`Open at login turned ${desired ? 'on' : 'off'}.`)
      }
      this.lastLogin = desired
    } catch (e) {
      this.deps.log.warn(`Open at login could not be changed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private skip(desired: boolean, reason: string): void {
    if (this.loggedSkip === desired) return
    this.loggedSkip = desired
    this.deps.log.info(`Open at login ${desired ? 'on' : 'off'} is not applied: ${reason}.`)
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
}
