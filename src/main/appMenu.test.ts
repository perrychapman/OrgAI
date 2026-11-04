import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { name: 'OrgAI', isPackaged: false },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {}
}))
vi.mock('./log', () => ({ logsDir: () => '/logs' }))

import type { MenuItemConstructorOptions } from 'electron'
import { DOCS_URL, ISSUES_URL, buildMenuTemplate, menuActionSender } from './appMenu'
import { IPC, MENU_ACTIONS } from '../shared/types'
import type { MenuAction } from '../shared/types'

type Item = MenuItemConstructorOptions

const build = (platform: string, isDev = false, extra: Partial<Parameters<typeof buildMenuTemplate>[0]> = {}) => {
  const send = vi.fn()
  const openExternal = vi.fn()
  const openLogs = vi.fn()
  const closeWindow = vi.fn()
  const template = buildMenuTemplate({ platform, appName: 'OrgAI', isDev, send, openExternal, openLogs, closeWindow, ...extra })
  return { template, send, openExternal, openLogs, closeWindow }
}

const walk = (items: Item[]): Item[] =>
  items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? walk(i.submenu as Item[]) : [])])

const menu = (t: Item[], label: string): Item[] => (t.find((m) => m.label === label)?.submenu ?? []) as Item[]
const find = (t: Item[], id: string): Item => {
  const it = walk(t).find((i) => i.id === id)
  if (!it) throw new Error(`no item ${id}`)
  return it
}
const roles = (t: Item[]): string[] => walk(t).flatMap((i) => (i.role ? [String(i.role)] : []))

describe.each(['darwin', 'win32', 'linux'])('buildMenuTemplate on %s', (platform) => {
  const mac = platform === 'darwin'

  it('has the expected top-level menus in order', () => {
    const labels = build(platform).template.map((m) => m.label)
    expect(labels).toEqual([...(mac ? ['OrgAI'] : []), 'File', 'Edit', 'View', 'Run', 'Window', 'Help'])
  })

  it('routes each id-bearing item to send with exactly its id, and covers every action once', () => {
    const { template, send } = build(platform)
    const ided = walk(template).filter((i) => i.id)
    for (const it of ided) {
      expect(MENU_ACTIONS as readonly string[]).toContain(it.id)
      send.mockClear()
      ;(it.click as () => void)()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(it.id)
    }
    expect(ided.map((i) => i.id).sort()).toEqual([...MENU_ACTIONS].sort())
  })

  it('sets the accelerators of the keyed items', () => {
    const { template } = build(platform)
    expect(find(template, 'toggle-sidebar').accelerator).toBe('CmdOrCtrl+B')
    expect(find(template, 'new-chat').accelerator).toBe('CmdOrCtrl+Shift+N')
    expect(find(template, 'new-run').accelerator).toBe('CmdOrCtrl+T')
    expect(find(template, 'new-project').accelerator).toBe('CmdOrCtrl+N')
    expect(find(template, 'open-app-settings').accelerator).toBe('CmdOrCtrl+,')
  })

  it('leaves the keys the renderer handles unregistered off macOS only', () => {
    const { template } = build(platform)
    for (const id of ['toggle-sidebar', 'new-chat', 'new-run']) {
      if (mac) expect(find(template, id).registerAccelerator).not.toBe(false)
      else expect(find(template, id).registerAccelerator).toBe(false)
    }
    expect(find(template, 'new-project').registerAccelerator).toBeUndefined()
    expect(find(template, 'open-app-settings').registerAccelerator).toBeUndefined()
  })

  it('has no Ctrl/Cmd+W anywhere, role defaults included', () => {
    const { template } = build(platform, true)
    for (const it of walk(template)) {
      expect(String(it.accelerator ?? '')).not.toMatch(/W$/i)
      expect(it.role).not.toBe('close')
    }
  })

  it('has the quit role only off macOS in File, and in the app menu on macOS', () => {
    const { template } = build(platform)
    if (mac) {
      expect(roles(menu(template, 'OrgAI'))).toContain('quit')
      expect(roles(menu(template, 'File'))).not.toContain('quit')
    } else {
      expect(roles(menu(template, 'File'))).toContain('quit')
    }
  })

  it('offers reload and devtools only in development', () => {
    expect(roles(menu(build(platform, true).template, 'View'))).toEqual(
      expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools'])
    )
    expect(roles(menu(build(platform, false).template, 'View'))).not.toContain('toggleDevTools')
  })

  it('opens only the two fixed URLs and the logs folder from Help', () => {
    const { template, openExternal, openLogs } = build(platform)
    const help = menu(template, 'Help')
    ;(help.find((i) => i.label === 'Documentation')!.click as () => void)()
    ;(help.find((i) => i.label === 'Report an issue')!.click as () => void)()
    expect(openExternal.mock.calls).toEqual([[DOCS_URL], [ISSUES_URL]])
    ;(help.find((i) => i.label === 'Open logs folder')!.click as () => void)()
    expect(openLogs).toHaveBeenCalledTimes(1)
  })

  it('has the right Window entries', () => {
    const win = menu(build(platform).template, 'Window')
    if (mac) expect(roles(win)).toEqual(['minimize', 'zoom', 'front'])
    else {
      const close = win.find((i) => i.label === 'Close window')!
      expect(close.accelerator).toBeUndefined()
      expect(close.role).toBeUndefined()
    }
  })
})

describe('menuActionSender', () => {
  const win = (destroyed = false, contentsDestroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => contentsDestroyed, send: vi.fn() }
  })

  it('sends { action } on menu:action to the focused window', () => {
    const a = win()
    const b = win()
    menuActionSender(() => a as never, () => [b, a] as never)('new-run')
    expect(a.webContents.send).toHaveBeenCalledWith(IPC.menuAction, { action: 'new-run' })
    expect(IPC.menuAction).toBe('menu:action')
    expect(b.webContents.send).not.toHaveBeenCalled()
  })

  it('skips destroyed windows and falls back to the first live one', () => {
    const dead = win(true)
    const deadContents = win(false, true)
    const live = win()
    menuActionSender(() => dead as never, () => [dead, deadContents, live] as never)('show-live')
    expect(dead.webContents.send).not.toHaveBeenCalled()
    expect(deadContents.webContents.send).not.toHaveBeenCalled()
    expect(live.webContents.send).toHaveBeenCalledWith('menu:action', { action: 'show-live' })
  })

  it('does nothing with no windows or an unknown action', () => {
    const live = win()
    expect(() => menuActionSender(() => null, () => [])('show-live')).not.toThrow()
    menuActionSender(() => live as never, () => [live] as never)('bogus' as MenuAction)
    expect(live.webContents.send).not.toHaveBeenCalled()
  })
})
