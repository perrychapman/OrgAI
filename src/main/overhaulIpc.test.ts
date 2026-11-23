// Every OVERHAUL_IPC channel is classified in DESKTOP_CHANNEL_MUTATES and registered through the helper that matches it,
// so a new channel that is not classified fails here instead of throwing at app startup.
import { describe, expect, it, vi } from 'vitest'
import { OVERHAUL_IPC } from '@shared/types'

const handlers = new Map<string, unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '1.2.3', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '/logs' }))

const { DESKTOP_CHANNEL_MUTATES, handleMutating, handleReadOnly } = await import('./ipc')
const { registerOverhaulIpc } = await import('./overhaulIpc')
const { HostActivityTracker } = await import('./host/activity')

const CHANNELS = Object.values(OVERHAUL_IPC)

describe('OVERHAUL_IPC classification', () => {
  it('lists every channel in DESKTOP_CHANNEL_MUTATES with a boolean', () => {
    const missing = CHANNELS.filter((c) => typeof DESKTOP_CHANNEL_MUTATES[c] !== 'boolean')
    expect(missing).toEqual([])
  })

  it('registers each channel with the helper that matches its value, without throwing', () => {
    handlers.clear()
    const viaMutating: string[] = []
    const viaReadOnly: string[] = []
    const activity = new HostActivityTracker()
    registerOverhaulIpc(
      (channel, fn) => {
        handleMutating(activity, channel, fn)
        viaMutating.push(channel)
      },
      (channel, fn) => {
        handleReadOnly(channel, fn)
        viaReadOnly.push(channel)
      },
      {} as never
    )
    expect([...viaMutating, ...viaReadOnly].sort()).toEqual([...CHANNELS].sort())
    for (const c of viaMutating) expect(DESKTOP_CHANNEL_MUTATES[c], c).toBe(true)
    for (const c of viaReadOnly) expect(DESKTOP_CHANNEL_MUTATES[c], c).toBe(false)
    for (const c of CHANNELS) expect(handlers.has(c), c).toBe(true)
  })
})
