import { describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  focused: null as { id: number } | null,
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn((t: unknown) => t),
  focusHandlers: [] as ((e: unknown, win: { id: number }) => void)[]
}))

vi.mock('electron', () => ({
  app: {
    name: 'OrgAI',
    isPackaged: false,
    getPath: () => '/data',
    on: (event: string, h: (e: unknown, win: { id: number }) => void) => {
      if (event === 'browser-window-focus') electronMock.focusHandlers.push(h)
    }
  },
  Menu: { setApplicationMenu: electronMock.setApplicationMenu, buildFromTemplate: electronMock.buildFromTemplate },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => electronMock.focused }
}))
vi.mock('./log', () => ({ logsDir: () => '/logs' }))

import type { MenuItemConstructorOptions } from 'electron'
import {
  DOCS_URL,
  ISSUES_URL,
  buildMenuTemplate,
  cleanMenuState,
  installAppMenu,
  menuActionSender,
  menuActionTarget,
  menuItemEnabled,
  navigateSender,
  openHelpUrl,
  setMenuState
} from './appMenu'
import { EMPTY_MENU_STATE, IPC, MENU_ACTIONS } from '../shared/types'
import type { MenuAction, MenuState } from '../shared/types'

type Item = MenuItemConstructorOptions

const FULL: MenuState = { hasProject: true, hasRun: true, runLive: true, chatRun: true, hasDecision: true }

const build = (platform: string, isDev = false, extra: Partial<Parameters<typeof buildMenuTemplate>[0]> = {}) => {
  const send = vi.fn()
  const openExternal = vi.fn()
  const openLogs = vi.fn()
  const openDataFolder = vi.fn()
  const closeWindow = vi.fn()
  const template = buildMenuTemplate({
    platform,
    appName: 'OrgAI',
    isDev,
    send,
    openExternal,
    openLogs,
    openDataFolder,
    closeWindow,
    ...extra
  })
  return { template, send, openExternal, openLogs, openDataFolder, closeWindow }
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
const labels = (items: Item[]): string[] => items.map((i) => (i.type === 'separator' ? '-' : (i.label ?? `role:${String(i.role)}`)))

describe.each(['darwin', 'win32', 'linux'])('buildMenuTemplate on %s', (platform) => {
  const mac = platform === 'darwin'

  it('has the expected top-level menus in order', () => {
    expect(build(platform).template.map((m) => m.label)).toEqual([
      ...(mac ? ['OrgAI'] : []), 'File', 'Edit', 'View', 'Run', 'Window', 'Help'
    ])
  })

  it('lays out File, View, Run and Help', () => {
    const { template } = build(platform)
    expect(labels(menu(template, 'File'))).toEqual([
      'New project', 'New chat', '-', 'Assistants', '-', 'Close tab', '-',
      ...(mac ? [] : ['App settings']),
      'Connections', 'Connectors', 'Skill library',
      ...(mac ? [] : ['-', 'role:quit'])
    ])
    expect(labels(menu(template, 'View')).slice(0, 7)).toEqual([
      'Live', 'History', 'Team', 'Project settings', '-', 'Toggle sidebar', 'Canvas'
    ])
    const canvas = menu(menu(template, 'View'), 'Canvas')
    expect(labels(canvas)).toEqual(['Show conversation', 'Hide finished agents', '-', 'Zoom in', 'Zoom out', 'Fit canvas'])
    expect(canvas.every((i) => i.accelerator === undefined)).toBe(true)
    expect(labels(menu(template, 'Run'))).toEqual([
      'New run', 'Open in new window', '-', 'Go to decision', 'Show what needs you', '-',
      'Interrupt turn', 'End session', '-', 'Save chat as project', 'Org retrospective'
    ])
    expect(labels(menu(template, 'Help'))).toEqual([
      'Documentation', 'Report an issue', 'Keyboard shortcuts', 'Ask OrgAI about itself…', '-', 'Open logs folder', 'Open data folder', '-', 'About OrgAI'
    ])
    if (mac) {
      expect(labels(menu(template, 'OrgAI'))).toEqual([
        'role:about', '-', 'Settings…', '-', 'role:hide', 'role:hideOthers', 'role:unhide', '-', 'role:quit'
      ])
    }
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
    const keys: Record<string, string> = {
      'toggle-sidebar': 'CmdOrCtrl+B',
      'new-chat': 'CmdOrCtrl+Shift+N',
      'new-run': 'CmdOrCtrl+T',
      'close-tab': 'CmdOrCtrl+W',
      'go-to-decision': 'CmdOrCtrl+.',
      'new-project': 'CmdOrCtrl+N',
      'open-app-settings': 'CmdOrCtrl+,',
      'show-live': 'CmdOrCtrl+1',
      'show-history': 'CmdOrCtrl+2',
      'show-team': 'CmdOrCtrl+3',
      'show-project-settings': 'CmdOrCtrl+4'
    }
    for (const [id, key] of Object.entries(keys)) expect(find(template, id).accelerator).toBe(key)
    const withKey = walk(template).filter((i) => i.id && i.accelerator).map((i) => i.id).sort()
    expect(withKey).toEqual(Object.keys(keys).sort())
  })

  it('leaves the keys the renderer handles unregistered off macOS only', () => {
    const { template } = build(platform)
    for (const id of ['toggle-sidebar', 'new-chat', 'new-run', 'close-tab', 'go-to-decision']) {
      if (mac) expect(find(template, id).registerAccelerator).not.toBe(false)
      else expect(find(template, id).registerAccelerator).toBe(false)
    }
    for (const id of ['new-project', 'open-app-settings', 'show-live', 'show-history', 'show-team', 'show-project-settings']) {
      expect(find(template, id).registerAccelerator).toBeUndefined()
    }
  })

  it('has only close-tab on W, and no window-closing item with a W accelerator', () => {
    const { template } = build(platform, true)
    const w = walk(template).filter((i) => /W$/i.test(String(i.accelerator ?? '')))
    expect(w.map((i) => i.id)).toEqual(['close-tab'])
    for (const it of walk(template)) expect(it.role).not.toBe('close')
    const closeWin = walk(template).find((i) => i.label === 'Close window')
    if (closeWin) expect(closeWin.accelerator).toBeUndefined()
  })

  it('has the quit role only off macOS in File, and in the app menu on macOS; Ctrl+Q on linux only', () => {
    const { template } = build(platform)
    if (mac) {
      expect(roles(menu(template, 'OrgAI'))).toContain('quit')
      expect(roles(menu(template, 'File'))).not.toContain('quit')
    } else {
      const quit = menu(template, 'File').find((i) => i.role === 'quit')!
      expect(quit).toBeDefined()
      expect(quit.accelerator).toBe(platform === 'linux' ? 'Ctrl+Q' : undefined)
    }
  })

  it('offers reload and devtools only in development', () => {
    expect(roles(menu(build(platform, true).template, 'View'))).toEqual(
      expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools'])
    )
    expect(roles(menu(build(platform, false).template, 'View'))).not.toContain('toggleDevTools')
  })

  it('opens only the two fixed URLs, the logs folder and the data folder from Help', () => {
    const { template, openExternal, openLogs, openDataFolder } = build(platform)
    const help = menu(template, 'Help')
    ;(help.find((i) => i.label === 'Documentation')!.click as () => void)()
    ;(help.find((i) => i.label === 'Report an issue')!.click as () => void)()
    expect(openExternal.mock.calls).toEqual([[DOCS_URL], [ISSUES_URL]])
    ;(help.find((i) => i.label === 'Open logs folder')!.click as () => void)()
    expect(openLogs).toHaveBeenCalledTimes(1)
    ;(help.find((i) => i.label === 'Open data folder')!.click as () => void)()
    expect(openDataFolder).toHaveBeenCalledTimes(1)
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

  it('enables items from the state', () => {
    const empty = walk(build(platform).template).filter((i) => i.id)
    for (const it of empty) expect(it.enabled).toBe(menuItemEnabled(it.id as MenuAction, EMPTY_MENU_STATE))
    const enabledEmpty = empty.filter((i) => i.enabled).map((i) => i.id).sort()
    expect(enabledEmpty).toEqual(
      MENU_ACTIONS.filter((a) => menuItemEnabled(a, EMPTY_MENU_STATE)).sort()
    )
    expect(enabledEmpty).toContain('new-project')
    expect(enabledEmpty).not.toContain('new-run')
    const full = walk(build(platform, false, { state: FULL }).template).filter((i) => i.id)
    expect(full.every((i) => i.enabled === true)).toBe(true)
  })
})

describe('menuItemEnabled', () => {
  const only = (k: keyof MenuState): MenuState => ({ ...EMPTY_MENU_STATE, [k]: true })
  const enabledFor = (state: MenuState) => MENU_ACTIONS.filter((a) => menuItemEnabled(a, state)).sort()

  it('follows the rule table', () => {
    const always = ['new-project', 'new-chat', 'open-chat', 'open-mcp-assistant', 'open-skill-assistant',
      'open-app-settings', 'open-connections', 'open-connectors', 'open-skill-library', 'open-about',
      'toggle-sidebar', 'keyboard-shortcuts', 'ask-about-orgai']
    expect(enabledFor(EMPTY_MENU_STATE)).toEqual([...always].sort())
    expect(enabledFor(only('hasProject'))).toEqual(
      [...always, 'show-live', 'show-history', 'show-team', 'show-project-settings', 'new-run'].sort()
    )
    expect(enabledFor(only('hasRun'))).toEqual(
      [...always, 'close-tab', 'open-run-window', 'toggle-conversation', 'toggle-hide-finished', 'canvas-fit',
        'canvas-zoom-in', 'canvas-zoom-out', 'org-retrospective'].sort()
    )
    expect(enabledFor(only('runLive'))).toEqual([...always, 'interrupt-run', 'end-session'].sort())
    expect(enabledFor(only('chatRun'))).toEqual([...always, 'save-chat-as-project'].sort())
    expect(enabledFor(only('hasDecision'))).toEqual([...always, 'go-to-decision', 'show-needs-you'].sort())
    expect(enabledFor(FULL)).toEqual([...MENU_ACTIONS].sort())
  })
})

describe('cleanMenuState', () => {
  it('keeps only exact true booleans of the five fields', () => {
    expect(cleanMenuState({ hasProject: true, hasRun: true, runLive: false, chatRun: 1, hasDecision: 'true', extra: true })).toEqual({
      hasProject: true, hasRun: true, runLive: false, chatRun: false, hasDecision: false
    })
    expect(cleanMenuState(FULL)).toEqual(FULL)
  })

  it('answers empty for junk', () => {
    for (const junk of [null, undefined, 5, 'x', true, [], [true], () => ({}), new Map(), Object.create({ hasRun: true })]) {
      expect(cleanMenuState(junk)).toEqual(EMPTY_MENU_STATE)
    }
    expect(cleanMenuState({})).toEqual(EMPTY_MENU_STATE)
    expect(Object.keys(cleanMenuState({ hasRun: true, evil: 'x' })).sort()).toEqual(
      ['chatRun', 'hasDecision', 'hasProject', 'hasRun', 'runLive']
    )
    expect(cleanMenuState(Object.assign(Object.create(null), { hasRun: true })).hasRun).toBe(true)
  })

  it('does not return the shared empty object', () => {
    expect(cleanMenuState(null)).not.toBe(EMPTY_MENU_STATE)
  })
})

describe('menuActionTarget', () => {
  it('classifies every action', () => {
    const main = ['new-project', 'new-chat', 'open-chat', 'open-mcp-assistant', 'open-skill-assistant', 'open-app-settings',
      'open-connections', 'open-connectors', 'open-skill-library', 'open-about', 'show-live', 'show-history', 'show-team',
      'show-project-settings', 'toggle-sidebar', 'keyboard-shortcuts', 'show-needs-you', 'ask-about-orgai']
    const focused = ['new-run', 'close-tab', 'interrupt-run', 'end-session', 'go-to-decision',
      'org-retrospective', 'save-chat-as-project', 'open-run-window', 'toggle-conversation', 'toggle-hide-finished',
      'canvas-fit', 'canvas-zoom-in', 'canvas-zoom-out']
    for (const a of MENU_ACTIONS) expect(menuActionTarget(a)).toBe(main.includes(a) ? 'main' : 'focused')
    expect([...main, ...focused].sort()).toEqual([...MENU_ACTIONS].sort())
  })
})

describe('menuActionSender', () => {
  const win = (destroyed = false, contentsDestroyed = false, minimized = false) => ({
    isDestroyed: () => destroyed,
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: () => contentsDestroyed,
      send: vi.fn(),
      once: vi.fn((_e: string, _l: () => void) => undefined)
    }
  })
  const RUN = { projectId: 'p', runId: 'r' }

  it('sends { action } on menu:action to the focused window for a run action', () => {
    const a = win()
    const b = win()
    menuActionSender(() => a, () => [[b, undefined], [a, undefined]])('new-run')
    expect(a.webContents.send).toHaveBeenCalledWith(IPC.menuAction, { action: 'new-run' })
    expect(IPC.menuAction).toBe('menu:action')
    expect(b.webContents.send).not.toHaveBeenCalled()
    expect(a.focus).not.toHaveBeenCalled()
  })

  it('sends a run action to a focused run window', () => {
    const main = win()
    const run = win()
    menuActionSender(() => run, () => [[main, undefined], [run, RUN]])('interrupt-run')
    expect(run.webContents.send).toHaveBeenCalledWith('menu:action', { action: 'interrupt-run' })
    expect(main.webContents.send).not.toHaveBeenCalled()
  })

  it('sends a run action to the main window when nothing is focused, else the first live window', () => {
    const main = win()
    const run = win()
    menuActionSender(() => null, () => [[run, RUN], [main, undefined]])('close-tab')
    expect(main.webContents.send).toHaveBeenCalledTimes(1)
    expect(run.webContents.send).not.toHaveBeenCalled()
    const r2 = win()
    menuActionSender(() => null, () => [[r2, RUN]])('close-tab')
    expect(r2.webContents.send).toHaveBeenCalled()
  })

  it('routes a navigation action from a run window to the main window, restoring and focusing it', () => {
    const main = win(false, false, true)
    const run = win()
    menuActionSender(() => run, () => [[run, RUN], [main, undefined]])('open-app-settings')
    expect(main.webContents.send).toHaveBeenCalledWith('menu:action', { action: 'open-app-settings' })
    expect(run.webContents.send).not.toHaveBeenCalled()
    expect(main.restore).toHaveBeenCalled()
    expect(main.focus).toHaveBeenCalled()
  })

  it('does not refocus a focused main window for a navigation action', () => {
    const main = win()
    menuActionSender(() => main, () => [[main, undefined]])('show-live')
    expect(main.webContents.send).toHaveBeenCalled()
    expect(main.focus).not.toHaveBeenCalled()
  })

  it('focuses the main window when nothing is focused', () => {
    const main = win()
    menuActionSender(() => null, () => [[main, undefined]])('show-live')
    expect(main.webContents.send).toHaveBeenCalled()
    expect(main.focus).toHaveBeenCalled()
    expect(main.restore).not.toHaveBeenCalled()
  })

  it('creates the main window for a navigation action and sends once its renderer is ready', () => {
    const run = win()
    const created = { ...win(), id: 501, once: vi.fn() }
    const createMain = vi.fn(() => created)
    menuActionSender(() => run, () => [[run, RUN]], createMain)('open-about')
    expect(createMain).toHaveBeenCalledTimes(1)
    expect(created.webContents.send).not.toHaveBeenCalled()
    expect(run.webContents.send).not.toHaveBeenCalled()
    expect(created.webContents.once).not.toHaveBeenCalled()
    setMenuState(created, EMPTY_MENU_STATE)
    expect(created.webContents.send).toHaveBeenCalledTimes(1)
    expect(created.webContents.send).toHaveBeenCalledWith('menu:action', { action: 'open-about' })
    expect(created.once).toHaveBeenCalledTimes(1)
  })

  it('does not create a main window for a run action or when one exists', () => {
    const main = win()
    const createMain = vi.fn(() => win())
    menuActionSender(() => null, () => [[main, undefined]], createMain)('show-team')
    menuActionSender(() => null, () => [], createMain)('new-run')
    expect(createMain).not.toHaveBeenCalled()
  })

  it('does not send to a window destroyed before the load finished', () => {
    let destroyed = false
    const created = { ...win(), id: 502, once: vi.fn(), isDestroyed: () => destroyed }
    menuActionSender(() => null, () => [], () => created)('show-team')
    destroyed = true
    setMenuState(created, EMPTY_MENU_STATE)
    expect(created.webContents.send).not.toHaveBeenCalled()
  })

  it('falls back to the focused run window, else the first live window, without a main window and no factory', () => {
    const run = win()
    const other = win()
    menuActionSender(() => run, () => [[other, RUN], [run, RUN]])('show-team')
    expect(run.webContents.send).toHaveBeenCalled()
    expect(other.webContents.send).not.toHaveBeenCalled()
    const r2 = win()
    menuActionSender(() => null, () => [[r2, RUN]])('show-team')
    expect(r2.webContents.send).toHaveBeenCalled()
  })

  it('skips destroyed windows and falls back to the first live one', () => {
    const dead = win(true)
    const deadContents = win(false, true)
    const live = win()
    menuActionSender(() => dead, () => [[dead, undefined], [deadContents, undefined], [live, undefined]])('show-live')
    expect(dead.webContents.send).not.toHaveBeenCalled()
    expect(deadContents.webContents.send).not.toHaveBeenCalled()
    expect(live.webContents.send).toHaveBeenCalledWith('menu:action', { action: 'show-live' })
  })

  it('does nothing with no windows or an unknown action', () => {
    const live = win()
    expect(() => menuActionSender(() => null, () => [])('show-live')).not.toThrow()
    menuActionSender(() => live, () => [[live, undefined]])('bogus' as MenuAction)
    expect(live.webContents.send).not.toHaveBeenCalled()
  })
})

describe('Help > Ask OrgAI about itself', () => {
  it('is a renderer item whose id is its action, on every platform, routed to main', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const { template, send } = build(platform)
      const help = template.find((m) => m.label === 'Help')!.submenu as Item[]
      const entry = help.find((i) => i.id === 'ask-about-orgai')!
      expect(entry.label).toBe('Ask OrgAI about itself…')
      ;(entry.click as () => void)()
      expect(send).toHaveBeenCalledWith('ask-about-orgai')
    }
    expect(menuActionTarget('ask-about-orgai')).toBe('main')
  })
})

describe('navigateSender', () => {
  let nextId = 900
  const win = (withId = false) => ({
    ...(withId ? { id: nextId++ } : {}),
    isDestroyed: () => false,
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    focus: vi.fn(),
    once: vi.fn(),
    webContents: { isDestroyed: () => false, send: vi.fn() }
  })
  const EVENT = { surfaceId: 'dashboard' as const, runId: 'r1', agentLabel: 'Assistant' }

  it('sends app:navigate to the unscoped main window, restored and focused, never a run window', () => {
    const main = win()
    const runWin = win()
    const ok = navigateSender(() => runWin, () => [[runWin, { projectId: 'p', runId: 'r' }], [main, undefined]])({ ...EVENT, extra: 1 } as never)
    expect(ok).toBe(true)
    expect(main.restore).toHaveBeenCalled()
    expect(main.focus).toHaveBeenCalled()
    expect(main.webContents.send).toHaveBeenCalledWith(IPC.appNavigate, EVENT)
    expect(runWin.webContents.send).not.toHaveBeenCalled()
  })
  it('creates the main window when closed and queues until its renderer reports ready', () => {
    const created = win(true)
    const go = navigateSender(() => null, () => [], () => created)
    expect(go(EVENT)).toBe(true)
    expect(created.webContents.send).not.toHaveBeenCalled()
    setMenuState(created as never, EMPTY_MENU_STATE)
    expect(created.webContents.send).toHaveBeenCalledWith(IPC.appNavigate, EVENT)
  })
  it('refuses an invalid event and answers false with no window to make', () => {
    const main = win()
    const go = navigateSender(() => null, () => [[main, undefined]])
    expect(go({ ...EVENT, surfaceId: 'nope' } as never)).toBe(false)
    expect(go({ ...EVENT, agentLabel: 'x'.repeat(81) })).toBe(false)
    expect(go({ ...EVENT, runId: 3 } as never)).toBe(false)
    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(navigateSender(() => null, () => [])(EVENT)).toBe(false)
  })
})

describe('openHelpUrl', () => {
  it('opens only the two fixed URLs', () => {
    const open = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(openHelpUrl(DOCS_URL, open)).toBe(true)
    expect(openHelpUrl(ISSUES_URL, open)).toBe(true)
    expect(openHelpUrl(DOCS_URL + '/', open)).toBe(false)
    expect(openHelpUrl('file:///C:/Windows/System32/calc.exe', open)).toBe(false)
    expect(open.mock.calls).toEqual([[DOCS_URL], [ISSUES_URL]])
    warn.mockRestore()
  })
})

describe('installAppMenu and setMenuState', () => {
  const enabledOf = (template: unknown, id: string): boolean | undefined =>
    walk(template as Item[]).find((i) => i.id === id)?.enabled

  it('rebuilds on focus with the focused window state, and on setMenuState only for the focused window', () => {
    const { setApplicationMenu, buildFromTemplate, focusHandlers } = electronMock
    installAppMenu(vi.fn())
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(enabledOf(buildFromTemplate.mock.results[0].value, 'new-run')).toBe(false)

    const winA = { id: 1, once: vi.fn() }
    const winB = { id: 2, once: vi.fn() }
    electronMock.focused = winA
    setApplicationMenu.mockClear()
    setMenuState(winB, { ...EMPTY_MENU_STATE, hasProject: true })
    expect(setApplicationMenu).not.toHaveBeenCalled()
    setMenuState(winA, { ...EMPTY_MENU_STATE, hasRun: true })
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    const last = () => buildFromTemplate.mock.results[buildFromTemplate.mock.results.length - 1].value
    expect(enabledOf(last(), 'close-tab')).toBe(true)
    expect(enabledOf(last(), 'new-run')).toBe(false)

    // Focus moves to B: its stored state drives the menu.
    focusHandlers[0]({}, winB)
    expect(enabledOf(last(), 'new-run')).toBe(true)
    expect(enabledOf(last(), 'close-tab')).toBe(false)
    // A window with no state gets the empty one.
    focusHandlers[0]({}, { id: 99 })
    expect(enabledOf(last(), 'new-run')).toBe(false)

    // Closing a window forgets its state.
    const closed = winA.once.mock.calls.find((c) => c[0] === 'closed')![1] as () => void
    closed()
    focusHandlers[0]({}, winA)
    expect(enabledOf(last(), 'close-tab')).toBe(false)
    electronMock.focused = null
  })

  describe('readiness queue, equality and main-routed enablement', () => {
    const fake = (id: number) => {
      const closers: (() => void)[] = []
      return {
        id,
        closers,
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: vi.fn() },
        once: vi.fn((_e: string, l: () => void) => {
          closers.push(l)
        })
      }
    }
    const sentActions = (w: ReturnType<typeof fake>): string[] =>
      w.webContents.send.mock.calls.map((c) => (c[1] as { action: string }).action)
    const lastTemplate = () => {
      const r = electronMock.buildFromTemplate.mock.results
      return r[r.length - 1].value
    }

    it('queues until the first setState, flushes in order with de-dup, then delivers at once', () => {
      const w = fake(601)
      const send = menuActionSender(() => w, () => [[w, undefined]])
      send('show-live')
      send('show-team')
      send('show-live')
      expect(w.webContents.send).not.toHaveBeenCalled()
      setMenuState(w, EMPTY_MENU_STATE)
      expect(sentActions(w)).toEqual(['show-team', 'show-live'])
      send('show-history')
      expect(sentActions(w)).toEqual(['show-team', 'show-live', 'show-history'])
      expect(w.once).toHaveBeenCalledTimes(1)
    })

    it('caps the queue at 8, dropping the oldest', () => {
      const w = fake(602)
      const send = menuActionSender(() => w, () => [[w, undefined]])
      const acts: MenuAction[] = ['show-live', 'show-history', 'show-team', 'show-project-settings', 'new-project',
        'new-chat', 'open-chat', 'open-about', 'open-connectors', 'open-connections']
      for (const a of acts) send(a)
      setMenuState(w, EMPTY_MENU_STATE)
      expect(sentActions(w)).toEqual(acts.slice(2))
    })

    it('forgets the queue and state when the window closes', () => {
      const w = fake(603)
      const send = menuActionSender(() => w, () => [[w, undefined]])
      send('show-live')
      expect(w.closers).toHaveLength(1)
      w.closers[0]()
      setMenuState(w, EMPTY_MENU_STATE)
      expect(w.webContents.send).not.toHaveBeenCalled()
      expect(w.closers).toHaveLength(2)
    })

    it('does not rebuild for an equal state, but does for a change', () => {
      const w = fake(604)
      menuActionSender(() => w, () => [[w, undefined]])
      electronMock.focused = w
      installAppMenu(vi.fn())
      setMenuState(w, { ...EMPTY_MENU_STATE, hasRun: true })
      electronMock.setApplicationMenu.mockClear()
      setMenuState(w, { ...EMPTY_MENU_STATE, hasRun: true })
      expect(electronMock.setApplicationMenu).not.toHaveBeenCalled()
      setMenuState(w, { ...EMPTY_MENU_STATE, hasRun: true, runLive: true })
      expect(electronMock.setApplicationMenu).toHaveBeenCalledTimes(1)
      electronMock.focused = null
    })

    it('rebuilds with the empty state when a window closes and none is focused', () => {
      const w = fake(605)
      menuActionSender(() => w, () => [[w, undefined]])
      electronMock.focused = w
      installAppMenu(vi.fn())
      setMenuState(w, FULL)
      expect(enabledOf(lastTemplate(), 'new-run')).toBe(true)
      electronMock.focused = null
      const before = electronMock.setApplicationMenu.mock.calls.length
      w.closers[0]()
      expect(electronMock.setApplicationMenu.mock.calls.length).toBe(before + 1)
      expect(enabledOf(lastTemplate(), 'new-run')).toBe(false)
    })

    it('enables main-routed items from the main window and run items from the focused window', () => {
      const main = fake(606)
      const run = fake(607)
      menuActionSender(() => run, () => [[main, undefined], [run, { projectId: 'p', runId: 'r' }]])
      electronMock.focused = run
      installAppMenu(vi.fn())
      setMenuState(main, { ...EMPTY_MENU_STATE, hasProject: true, hasDecision: true })
      setMenuState(run, { ...EMPTY_MENU_STATE, hasRun: true })
      const t = lastTemplate()
      expect(enabledOf(t, 'show-live')).toBe(true)
      expect(enabledOf(t, 'show-needs-you')).toBe(true)
      expect(enabledOf(t, 'go-to-decision')).toBe(false)
      expect(enabledOf(t, 'close-tab')).toBe(true)
      expect(enabledOf(t, 'new-run')).toBe(false)
      electronMock.focused = null
    })

    it('builds main-routed items from mainState', () => {
      const { template } = build('win32', false, {
        state: { ...EMPTY_MENU_STATE, hasRun: true },
        mainState: { ...EMPTY_MENU_STATE, hasProject: true }
      })
      expect(find(template, 'show-live').enabled).toBe(true)
      expect(find(template, 'close-tab').enabled).toBe(true)
      expect(find(template, 'new-run').enabled).toBe(false)
      expect(menuActionTarget('show-needs-you')).toBe('main')
    })
  })

  it('survives a failing Menu build', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    electronMock.buildFromTemplate.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => installAppMenu(vi.fn())).not.toThrow()
    warn.mockRestore()
  })
})
