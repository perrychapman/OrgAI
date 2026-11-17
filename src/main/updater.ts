/**
 * The desktop updater's controller (docs/agent-notes/updates.md). Electron-free and electron-updater-free: it drives an
 * injected UpdaterLike (the real NsisUpdater / MacUpdater / AppImageUpdater through updaterRuntime.ts, the scripted fake
 * of updaterMock.ts for ORGAI_UPDATE_MOCK, or a test fake), so every transition runs in vitest without a network.
 *
 * Consent: a check may run on its own (shortly after launch, then every UPDATE_CHECK_INTERVAL_MS, only while
 * AppSettings.autoUpdateCheck is on); a download and an install only on the user's updates:download / updates:install.
 * An install never bypasses the quit path: install() asks the app to quit (desktopQuit.ts ends and persists runs as a
 * normal quit does) and the installer is spawned from the app's 'quit' event (onAppQuit), after the shutdown released.
 *
 * Nothing the renderer sends reaches the updater: the feed is the embedded app-update.yml, the release page is built
 * from constants with a validated version, release notes cross IPC as bounded plain text and errors as fixed sentences.
 */
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_ERROR_MAX_CHARS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  UPDATE_MOCK_MODES,
  UPDATE_NOTES_MAX_CHARS,
  UPDATE_RELEASES_URL,
  UPDATE_VERSION_MAX_CHARS
} from '@shared/types'
import type {
  UpdateActionResult,
  UpdateCapability,
  UpdateCapabilityReason,
  UpdateInstallInput,
  UpdateMockMode,
  UpdateProgress,
  UpdateState
} from '@shared/types'

// ---------- The updater seam ----------

/** What a check answers (electron-updater's UpdateCheckResult, the fields used). null = the updater is inactive. */
export interface UpdaterCheckResult {
  isUpdateAvailable: boolean
  updateInfo: { version: unknown; releaseNotes?: unknown }
}

/** electron-updater's ProgressInfo, the fields used. */
export interface UpdaterProgressInfo {
  percent: number
  transferred: number
  total: number
}

/** The slice of electron-updater's AppUpdater the controller uses. */
export interface UpdaterLike {
  checkForUpdates(): Promise<UpdaterCheckResult | null>
  downloadUpdate(): Promise<unknown>
  /** BaseUpdater.install(isSilent, isForceRunAfter): spawns the downloaded installer. Called from the app's 'quit' event only. */
  install(isSilent: boolean, isForceRunAfter: boolean): boolean
  onProgress(cb: (p: UpdaterProgressInfo) => void): void
  /** electron-updater's autoInstallOnAppQuit (its own 'quit' handler reads it at quit time). */
  setAutoInstallOnQuit(on: boolean): void
}

// ---------- Pure helpers ----------

export interface CapabilityFacts {
  packaged: boolean
  platform: string
  /** ORGAI_MOCK=1: a mock / e2e / verify-pack launch. */
  testRun: boolean
  /** PORTABLE_EXECUTABLE_DIR is set (the Windows portable exe). */
  portable: boolean
  /** `Uninstall OrgAI.exe` sits beside the executable (installed by the NSIS installer). */
  nsisInstalled: boolean
}

export interface CapabilityDecision {
  capability: UpdateCapability
  reason?: UpdateCapabilityReason
}

/** Which install kind this is. Pure. Only a packaged, NSIS-installed Windows app that is not a test launch is 'auto'. */
export function updateCapability(f: CapabilityFacts): CapabilityDecision {
  if (!f.packaged) return { capability: 'none', reason: 'dev' }
  if (f.testRun) return { capability: 'none', reason: 'test' }
  if (f.platform === 'win32') {
    if (f.portable) return { capability: 'manual', reason: 'portable' }
    if (!f.nsisInstalled) return { capability: 'manual', reason: 'unpacked' }
    return { capability: 'auto' }
  }
  return { capability: 'manual', reason: 'platform' }
}

/** How the app gets its updater: electron-updater, the ORGAI_UPDATE_MOCK fake (unpackaged only), or none at all. */
export type UpdaterSource = { kind: 'electron' } | { kind: 'mock'; mode: UpdateMockMode } | { kind: 'none' }

export interface UpdaterSetup extends CapabilityDecision {
  source: UpdaterSource
}

/**
 * The capability plus where the updater comes from. Pure. ORGAI_UPDATE_MOCK is honoured only when the app is NOT
 * packaged (a packaged app ignores it); a mock gives 'auto' except mode 'manual'. Capability 'none' never loads
 * electron-updater, so it makes no request.
 */
export function resolveUpdaterSetup(f: CapabilityFacts, mockEnv: string | undefined): UpdaterSetup {
  if (!f.packaged && isUpdateMockMode(mockEnv)) {
    return mockEnv === 'manual'
      ? { capability: 'manual', reason: 'platform', source: { kind: 'mock', mode: mockEnv } }
      : { capability: 'auto', source: { kind: 'mock', mode: mockEnv } }
  }
  const d = updateCapability(f)
  return { ...d, source: d.capability === 'none' ? { kind: 'none' } : { kind: 'electron' } }
}

export function isUpdateMockMode(value: unknown): value is UpdateMockMode {
  return typeof value === 'string' && (UPDATE_MOCK_MODES as readonly string[]).includes(value)
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** A version from the feed: strict semver (no leading 'v'), at most UPDATE_VERSION_MAX_CHARS. */
export function isUpdateVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= UPDATE_VERSION_MAX_CHARS && SEMVER_RE.test(value)
}

/** The release page: built from the constant and a validated version only; anything else is the releases list. */
export function releaseUrlFor(version: string | undefined): string {
  return isUpdateVersion(version) ? `${UPDATE_RELEASES_URL}/tag/v${version}` : UPDATE_RELEASES_URL
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8}|#39);/g, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return codePoint(parseInt(name.slice(2), 16)) ?? ''
    if (name.startsWith('#') && name !== '#39') return codePoint(parseInt(name.slice(1), 10)) ?? ''
    return ENTITIES[name] ?? whole
  })
}

function codePoint(n: number): string | undefined {
  if (!Number.isFinite(n) || n < 0x20 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return n === 10 ? '\n' : undefined
  return String.fromCodePoint(n)
}

// C0 / C1 controls except tab and newline, the Arabic letter mark, zero-width and bidi characters, the line and paragraph
// separators and the BOM. Written as escapes: the source holds no invisible character.
// eslint-disable-next-line no-control-regex
const HIDDEN_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * The feed's release notes as plain text (untrusted). Accepts electron-updater's `string | ReleaseNoteInfo[] | null`
 * (GitHub gives HTML). Script / style blocks dropped, block tags become line breaks, other tags removed, entities
 * decoded once, hidden characters removed, blank runs collapsed, at most UPDATE_NOTES_MAX_CHARS (cut with '…').
 * undefined when nothing is left.
 */
export function plainReleaseNotes(notes: unknown): string | undefined {
  let raw = ''
  if (typeof notes === 'string') raw = notes
  else if (Array.isArray(notes)) {
    const parts: string[] = []
    for (const n of notes.slice(0, 50)) {
      if (!n || typeof n !== 'object') continue
      const { version, note } = n as { version?: unknown; note?: unknown }
      const head = typeof version === 'string' ? version : ''
      const body = typeof note === 'string' ? note : ''
      if (head || body) parts.push([head, body].filter(Boolean).join('\n'))
    }
    raw = parts.join('\n\n')
  } else return undefined
  // Bound the work before the regexes run.
  raw = raw.slice(0, UPDATE_NOTES_MAX_CHARS * 8)
  let t = raw
    .replace(/\r\n?/g, '\n')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|h[1-6]|pre|blockquote|tr|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  t = decodeEntities(t).replace(/\t/g, '  ').replace(HIDDEN_RE, '')
  t = t
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!t) return undefined
  return t.length > UPDATE_NOTES_MAX_CHARS ? `${t.slice(0, UPDATE_NOTES_MAX_CHARS - 1)}…` : t
}

/** The fixed sentences an error may cross IPC as. The raw message only goes to the log. */
export const UPDATE_ERROR_TEXT = {
  offline: 'OrgAI could not reach GitHub. Check your connection and try again.',
  notFound: 'No published release was found on GitHub.',
  rateLimited: 'GitHub refused the request for now. Try again later.',
  integrity: 'The downloaded update failed its integrity check and was discarded.',
  noConfig: 'This install has no update configuration.',
  inactive: 'Update checks are not available for this install.',
  badVersion: 'The update feed named a version OrgAI cannot read.',
  check: 'The update check failed. The log has the details.',
  download: 'The download failed. The log has the details.'
} as const

/** One fixed sentence for a failure (never a path, URL or token), at most UPDATE_ERROR_MAX_CHARS. Pure. */
export function updateErrorText(err: unknown, phase: 'check' | 'download'): string {
  const e = err as { message?: unknown; code?: unknown } | null | undefined
  const msg = `${typeof e?.code === 'string' ? e.code : ''} ${typeof e?.message === 'string' ? e.message : typeof err === 'string' ? err : ''}`
  let text: string
  if (/sha512|checksum/i.test(msg)) text = UPDATE_ERROR_TEXT.integrity
  else if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_/.test(msg)) text = UPDATE_ERROR_TEXT.offline
  else if (/\b403\b|\b429\b|rate limit/i.test(msg)) text = UPDATE_ERROR_TEXT.rateLimited
  else if (/\b404\b|Cannot find latest|No published versions|Unable to find latest version|Cannot find channel/i.test(msg)) text = UPDATE_ERROR_TEXT.notFound
  else if (/app-update\.yml/i.test(msg)) text = UPDATE_ERROR_TEXT.noConfig
  else text = phase === 'check' ? UPDATE_ERROR_TEXT.check : UPDATE_ERROR_TEXT.download
  return text.slice(0, UPDATE_ERROR_MAX_CHARS)
}

/** updates:install's argument rebuilt: absent = {}; a plain object whose `force` is exactly true, else false. */
export function updateInstallArgs(input: unknown): UpdateInstallInput {
  if (input === undefined || input === null) return { force: false }
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid install request.')
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) throw new Error('Invalid install request.')
  return { force: (input as { force?: unknown }).force === true }
}

function cleanProgress(p: UpdaterProgressInfo): UpdateProgress {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  return { percent: Math.min(100, num(p?.percent)), transferredBytes: Math.floor(num(p?.transferred)), totalBytes: Math.floor(num(p?.total)) }
}

// ---------- The controller ----------

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface UpdateControllerDeps {
  setup: CapabilityDecision
  currentVersion: string
  /** null exactly when capability is 'none' (nothing loaded, nothing requested). */
  updater: UpdaterLike | null
  /** AppSettings.autoUpdateCheck, read fresh. */
  autoCheck(): boolean
  /** Live runs installing would end (RunManager.liveRunCount()). */
  liveRunCount(): number
  /** The app is already quitting. */
  quitting(): boolean
  /** Start the normal quit (index.ts: app.quit() on the next tick, through desktopQuit.ts's before-quit). */
  requestQuit(): void
  /** shell.openExternal; only ever called with releaseUrlFor(...). */
  openExternal(url: string): void
  /** updates:changed to every window. */
  emit(state: UpdateState): void
  log: { info(message: string): void; warn(message: string): void }
  /** ORGAI_UPDATE_MOCK: an accepted install neither spawns an installer nor quits. */
  dryInstall?: boolean
  now?: () => number
  timers?: TimerApi
  firstDelayMs?: number
  intervalMs?: number
}

export class UpdateController {
  private status: UpdateState['status'] = 'idle'
  private availableVersion: string | undefined
  private releaseNotes: string | undefined
  private progress: UpdateProgress | undefined
  private checkedAt: number | undefined
  private error: string | undefined
  private installing = false
  private inFlight: Promise<UpdateState> | null = null
  private timer: unknown = undefined
  private started = false
  private disposed = false
  private lastEmittedPercent = -1
  private lastAutoAt: number | undefined
  private readonly timers: TimerApi
  private readonly now: () => number

  constructor(private readonly deps: UpdateControllerDeps) {
    this.timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
    this.now = deps.now ?? (() => Date.now())
    deps.updater?.onProgress((p) => this.onProgress(p))
  }

  get capability(): UpdateCapability {
    return this.deps.setup.capability
  }

  state(): UpdateState {
    const s: UpdateState = {
      capability: this.deps.setup.capability,
      status: this.status,
      currentVersion: this.deps.currentVersion,
      releaseUrl: releaseUrlFor(this.availableVersion)
    }
    if (this.deps.setup.capability !== 'auto' && this.deps.setup.reason) s.reason = this.deps.setup.reason
    if (this.availableVersion) s.availableVersion = this.availableVersion
    if (this.releaseNotes) s.releaseNotes = this.releaseNotes
    if (this.progress) s.progress = { ...this.progress }
    if (this.checkedAt !== undefined) s.checkedAt = this.checkedAt
    if (this.status === 'error' && this.error) s.error = this.error
    if (this.installing) s.installing = true
    return s
  }

  /** Arms the automatic checks (when the setting is on). Capability 'none' never arms anything. */
  start(): void {
    this.started = true
    this.reschedule()
  }

  /** AppSettings changed: arm or disarm the automatic checks. */
  settingsChanged(): void {
    if (this.started) this.reschedule()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  /** A check (manual or automatic). Joins one in flight; never checks while downloading, downloaded or installing. */
  check(): Promise<UpdateState> {
    const u = this.deps.updater
    if (!u || this.deps.setup.capability === 'none' || this.disposed) return Promise.resolve(this.state())
    if (this.inFlight) return this.inFlight
    if (this.status === 'downloading' || this.status === 'downloaded' || this.installing) return Promise.resolve(this.state())
    this.status = 'checking'
    this.error = undefined
    this.emit()
    const run = (async (): Promise<UpdateState> => {
      try {
        const r = await u.checkForUpdates()
        if (!r) {
          this.fail(UPDATE_ERROR_TEXT.inactive, 'The updater is inactive for this install.')
        } else if (r.isUpdateAvailable) {
          const v = r.updateInfo?.version
          if (!isUpdateVersion(v)) {
            // electron-updater now holds this (unreadable) release: forget the earlier one so no download starts for it.
            this.availableVersion = undefined
            this.releaseNotes = undefined
            this.progress = undefined
            this.fail(UPDATE_ERROR_TEXT.badVersion, 'The update feed named an invalid version.')
          } else {
            this.status = 'available'
            this.availableVersion = v
            this.releaseNotes = plainReleaseNotes(r.updateInfo.releaseNotes)
            this.progress = undefined
            this.deps.log.info(`Update available: ${v}`)
          }
        } else {
          this.status = 'up-to-date'
          this.availableVersion = undefined
          this.releaseNotes = undefined
          this.progress = undefined
        }
      } catch (e) {
        this.fail(updateErrorText(e, 'check'), `Update check failed: ${rawMessage(e)}`)
      }
      this.checkedAt = this.now()
      this.emit()
      return this.state()
    })()
    // Cleared once settled (also when the updater threw synchronously, before this line ran).
    this.inFlight = run
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null
    })
    return run
  }

  /** Starts the download the user asked for; answers once it started. */
  download(): UpdateActionResult {
    const u = this.deps.updater
    if (!u || this.deps.setup.capability !== 'auto') return { ok: false, reason: 'unsupported' }
    if (this.installing || this.deps.quitting()) return { ok: false, reason: 'quitting' }
    if (this.status === 'downloading' || this.status === 'downloaded') return { ok: true }
    if (!this.availableVersion || (this.status !== 'available' && this.status !== 'error')) return { ok: false, reason: 'not-available' }
    this.status = 'downloading'
    this.error = undefined
    this.progress = { percent: 0, transferredBytes: 0, totalBytes: 0 }
    this.lastEmittedPercent = 0
    this.emit()
    let started: Promise<unknown>
    try {
      started = Promise.resolve(u.downloadUpdate())
    } catch (e) {
      started = Promise.reject(e)
    }
    started.then(
      () => {
        if (this.status !== 'downloading') return
        this.status = 'downloaded'
        this.progress = { ...(this.progress ?? { transferredBytes: 0, totalBytes: 0 }), percent: 100 }
        this.deps.log.info(`Update ${this.availableVersion} downloaded.`)
        this.emit()
      },
      (e: unknown) => {
        if (this.status !== 'downloading') return
        this.fail(updateErrorText(e, 'download'), `Update download failed: ${rawMessage(e)}`)
        this.progress = undefined
        this.emit()
      }
    )
    return { ok: true }
  }

  /**
   * "Restart and install". Refused unless downloaded, and while runs are live unless `force` is exactly true. Accepted:
   * the app quits through the normal quit path and onAppQuit spawns the installer.
   */
  install(input: UpdateInstallInput = {}): UpdateActionResult {
    if (!this.deps.updater || this.deps.setup.capability !== 'auto') return { ok: false, reason: 'unsupported' }
    if (this.installing) return { ok: true }
    if (this.deps.quitting()) return { ok: false, reason: 'quitting' }
    if (this.status !== 'downloaded') return { ok: false, reason: 'not-downloaded' }
    const live = this.deps.liveRunCount()
    if (live > 0 && input.force !== true) return { ok: false, reason: 'active-runs', activeRuns: live }
    this.installing = true
    this.clearTimer()
    this.emit()
    if (this.deps.dryInstall) {
      this.deps.log.info('Update install accepted (mock): no installer runs and the app does not quit.')
      return { ok: true }
    }
    this.deps.log.info(`Installing update ${this.availableVersion} on quit${live > 0 ? ` (ending ${live} live run(s), confirmed)` : ''}.`)
    this.deps.requestQuit()
    return { ok: true }
  }

  /**
   * The app's 'quit' event (after desktopQuit.ts released everything). An accepted install spawns the installer now,
   * silently, and runs the app again afterwards. Without one, electron-updater's own quit handler
   * (autoInstallOnAppQuit) installs a downloaded update silently without relaunching.
   */
  onAppQuit(exitCode: number): void {
    if (exitCode !== 0) {
      // Not a clean quit: nothing installs (electron-updater's own handler also refuses a non-zero code).
      if (this.installing) this.deps.log.warn(`Update not installed: the app quit with code ${exitCode}.`)
      return
    }
    if (!this.installing || this.deps.dryInstall || !this.deps.updater) return
    try {
      if (!this.deps.updater.install(true, true)) this.deps.log.warn('The update installer did not start.')
    } catch (e) {
      this.deps.log.warn(`The update installer did not start: ${rawMessage(e)}`)
    }
  }

  /**
   * The shutdown failed and the app is about to app.exit(0) (desktopQuit.ts), which still emits 'quit' with code 0:
   * neither our install nor electron-updater's install-on-quit may run then. Idempotent.
   */
  cancelInstallOnQuit(): void {
    if (this.installing) this.deps.log.warn('Update install cancelled: the shutdown did not finish cleanly.')
    this.installing = false
    try {
      this.deps.updater?.setAutoInstallOnQuit(false)
    } catch (e) {
      this.deps.log.warn(`Could not turn off install on quit: ${rawMessage(e)}`)
    }
  }

  /** Opens the release page built in main (never a URL from the feed or the renderer). */
  openReleasePage(): void {
    const url = releaseUrlFor(this.availableVersion)
    if (url !== UPDATE_RELEASES_URL && !url.startsWith(`${UPDATE_RELEASES_URL}/tag/v`)) return
    this.deps.openExternal(url)
  }

  // ---- internals ----

  private fail(text: string, logLine: string): void {
    this.status = 'error'
    this.error = text
    this.deps.log.warn(logLine)
  }

  private onProgress(p: UpdaterProgressInfo): void {
    if (this.status !== 'downloading') return
    this.progress = cleanProgress(p)
    const whole = Math.floor(this.progress.percent)
    if (whole === this.lastEmittedPercent) return
    this.lastEmittedPercent = whole
    this.emit()
  }

  private emit(): void {
    try {
      this.deps.emit(this.state())
    } catch (e) {
      this.deps.log.warn(`Could not send the update state: ${rawMessage(e)}`)
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arms the next automatic check, or disarms it when the setting is off. */
  private reschedule(): void {
    if (this.disposed || this.installing || this.deps.setup.capability === 'none' || !this.deps.updater) return this.clearTimer()
    let on = false
    try {
      on = this.deps.autoCheck()
    } catch {
      on = false
    }
    if (!on) return this.clearTimer()
    if (this.timer !== undefined) return
    const first = this.deps.firstDelayMs ?? UPDATE_FIRST_CHECK_DELAY_MS
    const interval = this.deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
    // The last check or automatic attempt (an attempt skipped while downloading still waits a full interval).
    const last = Math.max(this.checkedAt ?? -Infinity, this.lastAutoAt ?? -Infinity)
    const delay = Number.isFinite(last) ? Math.max(first, interval - (this.now() - last)) : first
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      this.lastAutoAt = this.now()
      void this.check().finally(() => this.reschedule())
    }, delay)
  }
}

function rawMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > 500 ? `${m.slice(0, 500)}…` : m
}
