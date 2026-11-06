import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireHostOwnership, type HostOwnership } from '../../main/host/ownership'
import { newHostInstanceId } from '../../main/host/identity'
import { SettingsStore } from '../../main/store/settings'
import { fakeContext } from '../testing/fakeContext'
import { assertSettingsWritable, hostStartingMessage, readStoredTerminalAccess, writeTerminalAccess, writeTerminalAccessNow } from '../terminalAccessSettings'
import { EXIT } from '../types'
import { runTerminalAccess } from './terminalAccess'

const posix = process.platform !== 'win32'
// Short base: the d-<id>.sock path must stay under the 100-byte socket limit.
const SHORT_BASE = posix ? '/tmp' : tmpdir()

let base: string
let dataDir: string
let held: HostOwnership | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(SHORT_BASE, 'orgai-ta-')))
  dataDir = join(base, 'data')
})
afterEach(() => {
  held?.release()
  held = undefined
  rmSync(base, { recursive: true, force: true })
})

const ctxFor = (extra: Parameters<typeof fakeContext>[0] = {}) => fakeContext({ paths: { userDataDir: base, dataDir }, ...extra })
const settingsFile = (): Record<string, unknown> => (JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { settings: Record<string, unknown> }).settings

describe('terminal access settings (no host)', () => {
  it('reads defaults from a missing or junk file: not chosen, operate, open for a background host', () => {
    expect(readStoredTerminalAccess(dataDir)).toEqual({ terminalServer: false, terminalServerChosen: false, level: 'operate', levelChosen: false, enabledForBackground: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), '{nope')
    expect(readStoredTerminalAccess(dataDir).enabledForBackground).toBe(true)
  })

  it('an explicit off closes background hosts; saved on without a choice reads as off-but-unchosen', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, settings: { terminalServer: false, terminalServerChosen: true } }))
    expect(readStoredTerminalAccess(dataDir).enabledForBackground).toBe(false)
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, settings: { terminalServer: true } }))
    expect(readStoredTerminalAccess(dataDir)).toMatchObject({ terminalServer: false, terminalServerChosen: false, enabledForBackground: true })
  })

  it('writes only the Terminal access fields, keeps the rest, and SettingsStore reads the result', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, settings: { notifications: false, futureField: { a: 1 } } }))
    const s = writeTerminalAccessNow(dataDir, { on: true, level: 'operate' })
    expect(s).toMatchObject({ terminalServer: true, terminalServerChosen: true, level: 'operate', levelChosen: true })
    expect(settingsFile()).toEqual({ notifications: false, futureField: { a: 1 }, terminalServer: true, terminalServerChosen: true, terminalAccessLevel: 'operate', terminalAccessLevelChosen: true })
    const stored = new SettingsStore(dataDir).get()
    expect(stored).toMatchObject({ terminalServer: true, terminalServerChosen: true, terminalAccessLevel: 'operate', terminalAccessLevelChosen: true, notifications: false })
  })

  it('a stored full without the marker (a build before Wave 7 stored it only on a pick) counts as chosen; operate does not (review round 2)', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, settings: { terminalAccessLevel: 'full' } }))
    expect(readStoredTerminalAccess(dataDir)).toMatchObject({ level: 'full', levelChosen: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, settings: { terminalAccessLevel: 'operate' } }))
    expect(readStoredTerminalAccess(dataDir)).toMatchObject({ level: 'operate', levelChosen: false })
  })

  it('refuses to overwrite a settings.json that does not parse', () => {
    mkdirSync(dataDir, { recursive: true })
    expect(() => assertSettingsWritable(dataDir)).not.toThrow()
    writeFileSync(join(dataDir, 'settings.json'), '{nope')
    expect(() => assertSettingsWritable(dataDir)).toThrow(/could not be read/)
    expect(() => writeTerminalAccessNow(dataDir, { on: true })).toThrow(/could not be read/)
    expect(readFileSync(join(dataDir, 'settings.json'), 'utf8')).toBe('{nope')
  })
})

describe('orgai terminal-access', () => {
  it('prints the stored state without changing anything', async () => {
    const f = ctxFor()
    expect(await runTerminalAccess(f.ctx, [])).toBe(EXIT.ok)
    expect(f.out()).toContain('Terminal access: not chosen')
    expect(f.out()).toContain('Level: operate (not chosen yet)')
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(false)
    const j = ctxFor({ globals: { outputFormat: 'json' } })
    expect(await runTerminalAccess(j.ctx, [])).toBe(EXIT.ok)
    expect(JSON.parse(j.out())).toMatchObject({ changed: false, terminalServer: false, terminalAccessLevel: 'operate', enabledForBackgroundHosts: true })
  })

  it('on / off / --level write the choice with its marker under the startup mutex', async () => {
    const f = ctxFor()
    expect(await runTerminalAccess(f.ctx, ['on', '--level', 'full'])).toBe(EXIT.ok)
    expect(f.out()).toContain('Saved. Terminal access: on.')
    expect(settingsFile()).toMatchObject({ terminalServer: true, terminalServerChosen: true, terminalAccessLevel: 'full', terminalAccessLevelChosen: true })
    expect(existsSync(join(dataDir, 'run', 'startup.mkdir'))).toBe(false)
    expect(existsSync(join(dataDir, 'run', 'daemon.json'))).toBe(false)
    const g = ctxFor()
    expect(await runTerminalAccess(g.ctx, ['off'])).toBe(EXIT.ok)
    expect(settingsFile()).toMatchObject({ terminalServer: false, terminalServerChosen: true, terminalAccessLevel: 'full' })
    expect(readStoredTerminalAccess(dataDir).enabledForBackground).toBe(false)
    const h = ctxFor()
    expect(await runTerminalAccess(h.ctx, ['--level', 'operate'])).toBe(EXIT.ok)
    expect(settingsFile()).toMatchObject({ terminalServer: false, terminalAccessLevel: 'operate', terminalAccessLevelChosen: true })
  })

  it('a live process holding startup.mkdir past the wait is exit 6, never the delete-the-run-folder advice (review round 2)', async () => {
    const startup = join(dataDir, 'run', 'startup.mkdir')
    mkdirSync(startup, { recursive: true, mode: 0o700 })
    writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: 4242, hostInstanceId: '0f0f0f0f0f0f', createdAt: Date.now() }))
    const err = await writeTerminalAccess(dataDir, { on: true }, { liveness: () => 'same', liveWaitMs: 60, retryMs: 10 }).catch((e: unknown) => e)
    expect(err).toMatchObject({ exitCode: EXIT.hostBusy, message: hostStartingMessage(4242) })
    expect((err as Error).message).toBe('Another OrgAI process (pid 4242) is starting for this data folder; try again in a moment.')
    expect((err as Error).message).not.toMatch(/delete/i)
    // The live owner's mutex is left alone, and nothing was written.
    expect(existsSync(join(startup, 'owner.json'))).toBe(true)
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(false)
  })

  it('usage errors are exit 2', async () => {
    for (const args of [['maybe'], ['on', 'off'], ['--level', 'admin'], ['--bogus']]) {
      await expect(runTerminalAccess(ctxFor().ctx, args)).rejects.toMatchObject({ exitCode: EXIT.usage })
    }
  })

  it.skipIf(!posix)('refuses while a host owns the data folder (exit 1), and names the app for a desktop host', async () => {
    held = await acquireHostOwnership({ dataDir, hostKind: 'node', appVersion: 't', hostInstanceId: newHostInstanceId() })
    await expect(runTerminalAccess(ctxFor().ctx, ['on'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('Stop the background host first: orgai daemon stop') })
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(false)
    held.release()
    held = await acquireHostOwnership({ dataDir, hostKind: 'desktop', appVersion: 't', hostInstanceId: newHostInstanceId() })
    await expect(writeTerminalAccess(dataDir, { on: true })).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('App settings > General > Advanced settings > Terminal access') })
    // Reading still works while a host runs.
    expect(await runTerminalAccess(ctxFor().ctx, [])).toBe(EXIT.ok)
    held.release()
    // An in-process host is the user's own orgai command, not a background host (review round 1).
    held = await acquireHostOwnership({ dataDir, hostKind: 'inproc', appVersion: 't', hostInstanceId: newHostInstanceId() })
    const refusal = runTerminalAccess(ctxFor().ctx, ['--level', 'full'])
    await expect(refusal).rejects.toMatchObject({ exitCode: EXIT.failure, message: `An orgai command (pid ${process.pid}) is running its own host for this data folder; finish it, then try again.` })
  })
})
