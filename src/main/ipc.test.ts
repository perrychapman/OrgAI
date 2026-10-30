import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))

const { PICKED_FOLDERS_PER_SENDER, PickedFolders } = await import('./ipc')

describe('PickedFolders', () => {
  it('accepts a folder once, only from the renderer that picked it', () => {
    const p = new PickedFolders()
    p.remember(1, 'C:\\skills\\a')
    expect(p.take(2, 'C:\\skills\\a')).toBe(false)
    expect(p.take(1, 'C:\\skills\\b')).toBe(false)
    expect(p.take(1, 'C:\\skills\\a')).toBe(true)
    expect(p.take(1, 'C:\\skills\\a')).toBe(false)
  })

  it('keeps at most the newest folders per renderer and forgets a destroyed renderer', () => {
    const p = new PickedFolders()
    for (let i = 0; i <= PICKED_FOLDERS_PER_SENDER; i++) p.remember(1, `/f${i}`)
    p.remember(1, '/f1') // re-picking moves it to the newest end
    expect(p.take(1, '/f0')).toBe(false)
    expect(p.take(1, '/f1')).toBe(true)
    expect(p.take(1, `/f${PICKED_FOLDERS_PER_SENDER}`)).toBe(true)
    p.remember(3, '/x')
    p.forget(3)
    expect(p.take(3, '/x')).toBe(false)
  })
})
