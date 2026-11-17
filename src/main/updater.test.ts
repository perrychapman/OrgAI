import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_ERROR_MAX_CHARS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  UPDATE_MOCK_VERSION,
  UPDATE_NOTES_MAX_CHARS,
  UPDATE_RELEASES_URL,
  type UpdateState
} from '@shared/types'
import {
  UPDATE_ERROR_TEXT,
  UpdateController,
  isUpdateVersion,
  plainReleaseNotes,
  releaseUrlFor,
  resolveUpdaterSetup,
  updateCapability,
  updateErrorText,
  updateInstallArgs,
  type CapabilityFacts,
  type UpdateControllerDeps,
  type UpdaterCheckResult,
  type UpdaterLike,
  type UpdaterProgressInfo
} from './updater'
import { createMockUpdater } from './updaterMock'

afterEach(() => {
  vi.useRealTimers()
})

/** A controllable fake electron-updater: each call returns a promise the test settles. */
function fakeUpdater() {
  let progress: ((p: UpdaterProgressInfo) => void) | undefined
  const checks: Array<{ resolve: (r: UpdaterCheckResult | null) => void; reject: (e: unknown) => void }> = []
  const downloads: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  const u: UpdaterLike & { install: ReturnType<typeof vi.fn> } = {
    checkForUpdates: vi.fn(() => new Promise<UpdaterCheckResult | null>((resolve, reject) => void checks.push({ resolve, reject }))),
    downloadUpdate: vi.fn(() => new Promise<unknown>((resolve, reject) => void downloads.push({ resolve: () => resolve([]), reject }))),
    install: vi.fn(() => true),
    onProgress: (cb) => {
      progress = cb
    }
  }
  return { u, checks, downloads, progress: (p: UpdaterProgressInfo) => progress?.(p) }
}

function controller(over: Partial<UpdateControllerDeps> = {}) {
  const f = fakeUpdater()
  const emitted: UpdateState[] = []
  const deps: UpdateControllerDeps = {
    setup: { capability: 'auto' },
    currentVersion: '0.1.8',
    updater: f.u,
    autoCheck: () => true,
    liveRunCount: () => 0,
    quitting: () => false,
    requestQuit: vi.fn(),
    openExternal: vi.fn(),
    emit: (s) => void emitted.push(s),
    log: { info: vi.fn(), warn: vi.fn() },
    now: () => 1_000,
    ...over
  }
  const c = new UpdateController(deps)
  return { c, f, deps, emitted }
}

const available = (version = '0.2.0', releaseNotes: unknown = '<p>New &amp; better</p>'): UpdaterCheckResult => ({
  isUpdateAvailable: true,
  updateInfo: { version, releaseNotes }
})
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('updateCapability', () => {
  const base: CapabilityFacts = { packaged: true, platform: 'win32', testRun: false, portable: false, nsisInstalled: true }
  it('is auto only for a packaged NSIS-installed Windows app that is not a test launch', () => {
    expect(updateCapability(base)).toEqual({ capability: 'auto' })
    expect(updateCapability({ ...base, packaged: false })).toEqual({ capability: 'none', reason: 'dev' })
    expect(updateCapability({ ...base, testRun: true })).toEqual({ capability: 'none', reason: 'test' })
    expect(updateCapability({ ...base, portable: true })).toEqual({ capability: 'manual', reason: 'portable' })
    expect(updateCapability({ ...base, nsisInstalled: false })).toEqual({ capability: 'manual', reason: 'unpacked' })
    expect(updateCapability({ ...base, platform: 'darwin' })).toEqual({ capability: 'manual', reason: 'platform' })
    expect(updateCapability({ ...base, platform: 'linux' })).toEqual({ capability: 'manual', reason: 'platform' })
    // dev wins over everything, test over the platform.
    expect(updateCapability({ ...base, packaged: false, testRun: true, portable: true })).toEqual({ capability: 'none', reason: 'dev' })
    expect(updateCapability({ ...base, platform: 'darwin', testRun: true })).toEqual({ capability: 'none', reason: 'test' })
  })
})

describe('resolveUpdaterSetup', () => {
  const dev: CapabilityFacts = { packaged: false, platform: 'win32', testRun: true, portable: false, nsisInstalled: false }
  const packaged: CapabilityFacts = { packaged: true, platform: 'win32', testRun: false, portable: false, nsisInstalled: true }
  it('honours ORGAI_UPDATE_MOCK only when unpackaged', () => {
    expect(resolveUpdaterSetup(dev, 'available')).toEqual({ capability: 'auto', source: { kind: 'mock', mode: 'available' } })
    expect(resolveUpdaterSetup(dev, 'manual')).toEqual({ capability: 'manual', reason: 'platform', source: { kind: 'mock', mode: 'manual' } })
    expect(resolveUpdaterSetup(packaged, 'available')).toEqual({ capability: 'auto', source: { kind: 'electron' } })
    expect(resolveUpdaterSetup({ ...packaged, platform: 'darwin' }, 'error').source).toEqual({ kind: 'electron' })
  })
  it('loads nothing for capability none and ignores unknown mock values', () => {
    expect(resolveUpdaterSetup(dev, undefined)).toEqual({ capability: 'none', reason: 'dev', source: { kind: 'none' } })
    expect(resolveUpdaterSetup(dev, 'yes')).toEqual({ capability: 'none', reason: 'dev', source: { kind: 'none' } })
    expect(resolveUpdaterSetup({ ...packaged, testRun: true }, undefined).source).toEqual({ kind: 'none' })
  })
})

describe('pure helpers', () => {
  it('accepts strict semver only', () => {
    for (const v of ['0.1.8', '1.0.0-beta.1', '10.20.30+build.5']) expect(isUpdateVersion(v), v).toBe(true)
    for (const v of ['v1.0.0', '1.0', '01.0.0', '1.0.0/../x', '1.0.0 ', '', 1, null, `1.0.0-${'a'.repeat(70)}`]) expect(isUpdateVersion(v), String(v)).toBe(false)
  })

  it('builds the release URL from the constant and a valid version only', () => {
    expect(releaseUrlFor('1.2.3')).toBe(`${UPDATE_RELEASES_URL}/tag/v1.2.3`)
    expect(releaseUrlFor(undefined)).toBe(UPDATE_RELEASES_URL)
    expect(releaseUrlFor('1.2.3/../../evil')).toBe(UPDATE_RELEASES_URL)
    expect(releaseUrlFor('https://evil.example')).toBe(UPDATE_RELEASES_URL)
  })

  it('turns HTML release notes into bounded plain text', () => {
    const html = '<h2>What&#39;s new</h2><ul><li>Fast &amp; <b>safe</b></li><li>x &lt;script&gt;</li></ul><script>alert(1)</script><p>End&nbsp;line</p>'
    expect(plainReleaseNotes(html)).toBe("What's new\n\n- Fast & safe\n- x <script>\nEnd line")
    expect(plainReleaseNotes('a\u202Eb\u0007c\u200Bd')).toBe('abcd')
    expect(plainReleaseNotes([{ version: '1.0.0', note: '<p>one</p>' }, { version: '0.9.0', note: null }, 7])).toBe('1.0.0\none\n\n0.9.0')
    expect(plainReleaseNotes(null)).toBeUndefined()
    expect(plainReleaseNotes({ note: 'x' })).toBeUndefined()
    expect(plainReleaseNotes('<p> </p>')).toBeUndefined()
    const long = plainReleaseNotes('x'.repeat(UPDATE_NOTES_MAX_CHARS * 20))!
    expect(long).toHaveLength(UPDATE_NOTES_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    // Entities decode once: an escaped entity stays text.
    expect(plainReleaseNotes('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;')
  })

  it('maps failures to fixed sentences without paths, URLs or tokens', () => {
    const secret = 'C:\\Users\\me\\AppData\\Local\\orgai-updater token=ghp_abc https://github.com/x'
    expect(updateErrorText(new Error(`sha512 checksum mismatch ${secret}`), 'download')).toBe(UPDATE_ERROR_TEXT.integrity)
    expect(updateErrorText(Object.assign(new Error(secret), { code: 'ENOTFOUND' }), 'check')).toBe(UPDATE_ERROR_TEXT.offline)
    expect(updateErrorText(new Error('net::ERR_INTERNET_DISCONNECTED'), 'check')).toBe(UPDATE_ERROR_TEXT.offline)
    expect(updateErrorText(new Error('HttpError: 404 Not Found'), 'check')).toBe(UPDATE_ERROR_TEXT.notFound)
    expect(updateErrorText(new Error('HttpError: 403 rate limit exceeded'), 'check')).toBe(UPDATE_ERROR_TEXT.rateLimited)
    expect(updateErrorText(new Error(`ENOENT ${secret}\\app-update.yml`), 'check')).toBe(UPDATE_ERROR_TEXT.noConfig)
    expect(updateErrorText(new Error(secret), 'check')).toBe(UPDATE_ERROR_TEXT.check)
    expect(updateErrorText('boom', 'download')).toBe(UPDATE_ERROR_TEXT.download)
    for (const t of Object.values(UPDATE_ERROR_TEXT)) expect(t.length).toBeLessThanOrEqual(UPDATE_ERROR_MAX_CHARS)
  })

  it('rebuilds the install input: only an exact force: true counts', () => {
    expect(updateInstallArgs(undefined)).toEqual({ force: false })
    expect(updateInstallArgs(null)).toEqual({ force: false })
    expect(updateInstallArgs({ force: true, url: 'x' })).toEqual({ force: true })
    expect(updateInstallArgs({ force: 'true' })).toEqual({ force: false })
    expect(updateInstallArgs({ force: 1 })).toEqual({ force: false })
    for (const bad of ['x', 1, [true], new Date()]) expect(() => updateInstallArgs(bad), String(bad)).toThrow('Invalid install request.')
  })
})

describe('UpdateController (auto)', () => {
  it('starts idle with the current version and the releases URL', () => {
    const { c } = controller()
    expect(c.state()).toEqual({ capability: 'auto', status: 'idle', currentVersion: '0.1.8', releaseUrl: UPDATE_RELEASES_URL })
  })

  it('check -> available -> download progress -> downloaded -> install refused with live runs -> forced install', async () => {
    let live = 2
    const { c, f, deps, emitted } = controller({ liveRunCount: () => live })
    const checking = c.check()
    expect(c.state().status).toBe('checking')
    f.checks[0].resolve(available('0.2.0'))
    const s = await checking
    expect(s).toMatchObject({ status: 'available', availableVersion: '0.2.0', releaseNotes: 'New & better', releaseUrl: `${UPDATE_RELEASES_URL}/tag/v0.2.0`, checkedAt: 1_000 })

    expect(c.install()).toEqual({ ok: false, reason: 'not-downloaded' })
    expect(c.download()).toEqual({ ok: true })
    expect(c.state()).toMatchObject({ status: 'downloading', progress: { percent: 0, transferredBytes: 0, totalBytes: 0 } })
    expect(c.download()).toEqual({ ok: true }) // a second click joins
    expect(f.u.downloadUpdate).toHaveBeenCalledTimes(1)
    const before = emitted.length
    f.progress({ percent: 41.2, transferred: 412, total: 1000 })
    f.progress({ percent: 41.9, transferred: 419, total: 1000 }) // same whole percent: no extra push
    f.progress({ percent: 250, transferred: -5, total: Number.NaN }) // clamped
    expect(emitted.length).toBe(before + 2)
    expect(emitted[before].progress).toEqual({ percent: 41.2, transferredBytes: 412, totalBytes: 1000 })
    expect(c.state().progress).toEqual({ percent: 100, transferredBytes: 0, totalBytes: 0 })
    f.downloads[0].resolve()
    await flush()
    expect(c.state().status).toBe('downloaded')

    expect(c.install()).toEqual({ ok: false, reason: 'active-runs', activeRuns: 2 })
    expect(c.install({ force: false })).toEqual({ ok: false, reason: 'active-runs', activeRuns: 2 })
    expect(deps.requestQuit).not.toHaveBeenCalled()
    expect(c.install({ force: true })).toEqual({ ok: true })
    expect(deps.requestQuit).toHaveBeenCalledTimes(1)
    expect(c.state().installing).toBe(true)
    expect(c.install({ force: true })).toEqual({ ok: true }) // idempotent, no second quit
    expect(deps.requestQuit).toHaveBeenCalledTimes(1)
    // The installer starts only from the app's 'quit' event, silent, running the app again.
    expect(f.u.install).not.toHaveBeenCalled()
    c.onAppQuit()
    expect(f.u.install).toHaveBeenCalledWith(true, true)
    live = 0
  })

  it('installs without force when no run is live', async () => {
    const { c, f, deps } = controller()
    const p = c.check()
    f.checks[0].resolve(available())
    await p
    c.download()
    f.downloads[0].resolve()
    await flush()
    expect(c.install()).toEqual({ ok: true })
    expect(deps.requestQuit).toHaveBeenCalledTimes(1)
  })

  it('a quit without an accepted install leaves installing to electron-updater (no explicit install call)', () => {
    const { c, f } = controller()
    c.onAppQuit()
    expect(f.u.install).not.toHaveBeenCalled()
  })

  it('refuses download and install while the app is quitting', async () => {
    let quitting = false
    const { c, f } = controller({ quitting: () => quitting })
    const p = c.check()
    f.checks[0].resolve(available())
    await p
    quitting = true
    expect(c.download()).toEqual({ ok: false, reason: 'quitting' })
    quitting = false
    c.download()
    f.downloads[0].resolve()
    await flush()
    quitting = true
    expect(c.install({ force: true })).toEqual({ ok: false, reason: 'quitting' })
  })

  it('reports up-to-date and clears an earlier available version', async () => {
    const { c, f } = controller()
    let p = c.check()
    f.checks[0].resolve(available('0.2.0'))
    await p
    p = c.check()
    f.checks[1].resolve({ isUpdateAvailable: false, updateInfo: { version: '0.1.8' } })
    const s = await p
    expect(s.status).toBe('up-to-date')
    expect(s.availableVersion).toBeUndefined()
    expect(s.releaseNotes).toBeUndefined()
    expect(c.download()).toEqual({ ok: false, reason: 'not-available' })
  })

  it('never runs two checks at once', async () => {
    const { c, f } = controller()
    const a = c.check()
    const b = c.check()
    expect(b).toBe(a)
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
    f.checks[0].resolve(available())
    await a
  })

  it('a check that throws synchronously is an error and does not block the next check', async () => {
    const { c, f } = controller()
    ;(f.u.checkForUpdates as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(await c.check()).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.check })
    await flush()
    const p = c.check()
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(2)
    f.checks[0].resolve(available())
    expect((await p).status).toBe('available')
  })

  it('does not check while downloading or downloaded', async () => {
    const { c, f } = controller()
    const p = c.check()
    f.checks[0].resolve(available())
    await p
    c.download()
    await c.check()
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
    f.downloads[0].resolve()
    await flush()
    await c.check()
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('a failed check is an error with a fixed sentence; the raw text goes to the log only', async () => {
    const { c, f, deps } = controller()
    const p = c.check()
    f.checks[0].reject(Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com C:\\secret'), { code: 'ENOTFOUND' }))
    const s = await p
    expect(s).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.offline, checkedAt: 1_000 })
    expect(JSON.stringify(s)).not.toContain('secret')
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'))
    // A manual retry works.
    const q = c.check()
    f.checks[1].resolve(available())
    expect((await q).status).toBe('available')
  })

  it('an inactive updater (null) and an invalid feed version are errors', async () => {
    const { c, f } = controller()
    let p = c.check()
    f.checks[0].resolve(null)
    expect(await p).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.inactive })
    p = c.check()
    f.checks[1].resolve(available('1.0.0/../../x'))
    const s = await p
    expect(s).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.badVersion })
    expect(s.availableVersion).toBeUndefined()
    expect(s.releaseUrl).toBe(UPDATE_RELEASES_URL)
  })

  it('a failed download keeps the version so it can be retried', async () => {
    const { c, f } = controller()
    const p = c.check()
    f.checks[0].resolve(available('0.3.0'))
    await p
    c.download()
    f.downloads[0].reject(new Error('sha512 checksum mismatch, expected abc'))
    await flush()
    expect(c.state()).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.integrity, availableVersion: '0.3.0' })
    expect(c.state().progress).toBeUndefined()
    expect(c.install()).toEqual({ ok: false, reason: 'not-downloaded' })
    expect(c.download()).toEqual({ ok: true })
    expect(f.u.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('a download that throws synchronously is an error, not a crash', async () => {
    const { c, f } = controller()
    const p = c.check()
    f.checks[0].resolve(available())
    await p
    ;(f.u.downloadUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(c.download()).toEqual({ ok: true })
    await flush()
    expect(c.state()).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.download })
  })

  it('opens only the release page built in main', async () => {
    const { c, f, deps } = controller()
    c.openReleasePage()
    expect(deps.openExternal).toHaveBeenLastCalledWith(UPDATE_RELEASES_URL)
    const p = c.check()
    f.checks[0].resolve(available('0.4.1'))
    await p
    c.openReleasePage()
    expect(deps.openExternal).toHaveBeenLastCalledWith(`${UPDATE_RELEASES_URL}/tag/v0.4.1`)
  })

  it('an emit that throws is logged, never thrown to the caller', async () => {
    const { c, f, deps } = controller({
      emit: () => {
        throw new Error('window gone')
      }
    })
    const p = c.check()
    f.checks[0].resolve(available())
    await expect(p).resolves.toMatchObject({ status: 'available' })
    expect(deps.log.warn).toHaveBeenCalled()
  })
})

describe('UpdateController (manual and none)', () => {
  it('manual: checks report the version; download and install are refused', async () => {
    const { c, f, deps } = controller({ setup: { capability: 'manual', reason: 'platform' } })
    expect(c.state()).toMatchObject({ capability: 'manual', reason: 'platform' })
    const p = c.check()
    f.checks[0].resolve(available('0.5.0'))
    expect(await p).toMatchObject({ status: 'available', availableVersion: '0.5.0', releaseUrl: `${UPDATE_RELEASES_URL}/tag/v0.5.0` })
    expect(c.download()).toEqual({ ok: false, reason: 'unsupported' })
    expect(c.install({ force: true })).toEqual({ ok: false, reason: 'unsupported' })
    expect(f.u.downloadUpdate).not.toHaveBeenCalled()
    expect(deps.requestQuit).not.toHaveBeenCalled()
    c.openReleasePage()
    expect(deps.openExternal).toHaveBeenCalledWith(`${UPDATE_RELEASES_URL}/tag/v0.5.0`)
  })

  it('none: no updater, nothing scheduled, everything answers locally', async () => {
    vi.useFakeTimers()
    const { c, deps } = controller({ setup: { capability: 'none', reason: 'dev' }, updater: null })
    c.start()
    expect(vi.getTimerCount()).toBe(0)
    expect(await c.check()).toEqual({ capability: 'none', reason: 'dev', status: 'idle', currentVersion: '0.1.8', releaseUrl: UPDATE_RELEASES_URL })
    expect(c.download()).toEqual({ ok: false, reason: 'unsupported' })
    expect(c.install({ force: true })).toEqual({ ok: false, reason: 'unsupported' })
    expect(deps.requestQuit).not.toHaveBeenCalled()
  })
})

describe('UpdateController automatic checks', () => {
  it('checks after the first delay, then every interval, while the setting is on', async () => {
    vi.useFakeTimers()
    let now = 0
    const { c, f } = controller({ now: () => now })
    c.start()
    expect(f.u.checkForUpdates).not.toHaveBeenCalled()
    now += UPDATE_FIRST_CHECK_DELAY_MS
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
    f.checks[0].resolve({ isUpdateAvailable: false, updateInfo: { version: '0.1.8' } })
    await flush()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
    now += UPDATE_CHECK_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(1)
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(2)
    c.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('turning the setting off stops the timer; turning it on arms it again', async () => {
    vi.useFakeTimers()
    let on = true
    const { c, f } = controller({ autoCheck: () => on })
    c.start()
    expect(vi.getTimerCount()).toBe(1)
    on = false
    c.settingsChanged()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(f.u.checkForUpdates).not.toHaveBeenCalled()
    // A manual check still works with the setting off.
    void c.check()
    expect(f.u.checkForUpdates).toHaveBeenCalledTimes(1)
    on = true
    c.settingsChanged()
    expect(vi.getTimerCount()).toBe(1)
    c.settingsChanged() // already armed: no second timer
    expect(vi.getTimerCount()).toBe(1)
  })

  it('off at launch arms nothing; settingsChanged before start does nothing', () => {
    vi.useFakeTimers()
    const { c } = controller({ autoCheck: () => false })
    c.settingsChanged()
    c.start()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an accepted install disarms the timer', async () => {
    vi.useFakeTimers()
    const { c, f } = controller()
    const p = c.check()
    f.checks[0].resolve(available())
    await p
    c.download()
    f.downloads[0].resolve()
    await flush()
    c.start()
    expect(vi.getTimerCount()).toBe(1)
    expect(c.install()).toEqual({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ORGAI_UPDATE_MOCK fake', () => {
  it('available: check, stepped download, dry install that never quits', async () => {
    vi.useFakeTimers()
    const { c, deps } = controller({ updater: createMockUpdater('available'), dryInstall: true, liveRunCount: () => 1 })
    const p = c.check()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toMatchObject({ status: 'available', availableVersion: UPDATE_MOCK_VERSION })
    expect(c.state().releaseNotes).toContain('Notes arrive as HTML & are shown as text.')
    c.download()
    await vi.advanceTimersByTimeAsync(2000)
    expect(c.state()).toMatchObject({ status: 'downloaded', progress: { percent: 100 } })
    expect(c.install()).toEqual({ ok: false, reason: 'active-runs', activeRuns: 1 })
    expect(c.install({ force: true })).toEqual({ ok: true })
    expect(deps.requestQuit).not.toHaveBeenCalled()
    c.onAppQuit()
  })

  it('error, up-to-date and download-error behave as documented', async () => {
    vi.useFakeTimers()
    const err = controller({ updater: createMockUpdater('error'), dryInstall: true }).c
    const e = err.check()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await e).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.offline })
    const ok = controller({ updater: createMockUpdater('up-to-date'), dryInstall: true }).c
    const u = ok.check()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await u).status).toBe('up-to-date')
    const dl = controller({ updater: createMockUpdater('download-error'), dryInstall: true }).c
    const d = dl.check()
    await vi.advanceTimersByTimeAsync(1000)
    await d
    dl.download()
    await vi.advanceTimersByTimeAsync(2000)
    expect(dl.state()).toMatchObject({ status: 'error', error: UPDATE_ERROR_TEXT.offline, availableVersion: UPDATE_MOCK_VERSION })
  })
})
