import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from './context'
import { KeyParser } from './input/keys'
import { SLASH_COMMANDS } from './slashCommands'
import { SlashPalette } from './SlashPalette'
import { textWidth } from './panes/text'
import type { InputEvent, SlashPaletteProps, TuiEnv, TuiState } from './types'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
// eslint-disable-next-line no-control-regex
const plain = (s: string | undefined) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')

const state: TuiState = {
  connection: 'live',
  folder: '/tmp/p',
  project: { id: 'p1', name: 'P' } as TuiState['project'],
  runs: {},
  runOrder: [],
  activeChain: [],
  composeTarget: 'new',
  notices: [],
  resolved: [],
  cardSeq: 0
}

function setup(over: Partial<SlashPaletteProps> = {}, env: Partial<TuiEnv> = {}) {
  const bus = new InputBus()
  const props: SlashPaletteProps = {
    width: 60,
    height: 30,
    focused: true,
    query: '/',
    commands: SLASH_COMMANDS,
    state,
    onRun: vi.fn(),
    onClose: vi.fn(),
    ...over
  }
  const r = render(
    <TuiEnvContext.Provider value={{ ...DEFAULT_TUI_ENV, ...env }}>
      <InputBusContext.Provider value={bus}>
        <SlashPalette {...props} />
      </InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
  const send = async (s: string | InputEvent) => {
    const p = new KeyParser({ bracketedPaste: true })
    const evs = typeof s === 'string' ? [...p.feed(s), ...p.flush()] : [s]
    const out = evs.map((e) => bus.dispatch(e, 'palette'))
    await tick()
    return out
  }
  return { bus, props, r, send, frame: () => plain(r.lastFrame()) }
}

const runCalls = (fn: SlashPaletteProps['onRun']) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0].name, c[1]])

describe('SlashPalette', () => {
  it('lists the available commands and filters as you type', async () => {
    const t = setup()
    expect(t.frame()).toContain('Commands')
    expect(t.frame()).toContain('Type to search commands')
    expect(t.frame()).toContain('/help')
    expect(t.frame()).toContain('/quit')
    // interrupt / stop need an open active run.
    expect(t.frame()).not.toContain('/interrupt')
    await t.send('ru')
    // A slow runner may not have redrawn after one tick: wait for the frame rather than read it at once.
    await vi.waitFor(() => expect(t.frame().split('\n')[0]).toContain('/ru'))
    const f = t.frame()
    expect(f).toContain('/run')
    expect(f).toContain('/runs')
    expect(f).not.toContain('/help')
    await t.send('zz')
    await vi.waitFor(() => expect(t.frame()).toContain('No matching command'))
    t.r.unmount()
  })

  it('Up / Down select and Enter runs the selection', async () => {
    const t = setup({ query: '/ru' })
    await t.send('\x1b[B') // down: runs
    await t.send('\r')
    expect(runCalls(t.props.onRun)).toEqual([['runs', '']])
    await t.send('\x1b[A') // up: back to run
    await t.send('\r')
    expect(runCalls(t.props.onRun)[1]).toEqual(['run', ''])
    t.r.unmount()
  })

  it('Tab completes the name and Enter passes the arguments', async () => {
    const t = setup()
    await t.send('ne')
    await t.send('\t')
    expect(t.frame().split('\n')[0].trim()).toBe('Commands  /new _')
    await t.send('fix the build\r')
    expect(runCalls(t.props.onRun)).toEqual([['new', 'fix the build']])
    t.r.unmount()
  })

  it('an exact alias wins over the selection', async () => {
    const t = setup()
    await t.send('q\r')
    expect(runCalls(t.props.onRun)).toEqual([['quit', '']])
    t.r.unmount()
  })

  it('Esc closes, and Backspace on a bare "/" closes', async () => {
    const t = setup()
    await t.send('\x1b')
    expect(t.props.onClose).toHaveBeenCalledTimes(1)
    const u = setup({ query: '/h' })
    await u.send('\x7f')
    expect(u.props.onClose).not.toHaveBeenCalled()
    expect(u.frame().split('\n')[0]).toContain('Commands  /_')
    await u.send('\x7f')
    expect(u.props.onClose).toHaveBeenCalledTimes(1)
    t.r.unmount()
    u.r.unmount()
  })

  it('a paste filters without running anything and stays one line', async () => {
    const t = setup()
    await t.send({ type: 'paste', text: 'diff\nmain' })
    expect(t.props.onRun).not.toHaveBeenCalled()
    expect(t.frame().split('\n')[0]).toContain('/diff main')
    t.r.unmount()
  })

  it('an empty query lists /help and /new first, then the rest alphabetically', () => {
    const t = setup({ height: 30 })
    const names = t.frame().split('\n').slice(1).map((l) => /^[ ›>]\s*\/(\S+)/.exec(l)?.[1]).filter(Boolean) as string[]
    expect(names.slice(0, 2)).toEqual(['help', 'new'])
    const rest = names.slice(2)
    expect(rest).toEqual([...rest].sort())
    t.r.unmount()
  })

  it.each([120, 100, 80, 70])('at width %i: "N more" is honest and no row is wider than the width (Ink trims trailing blanks, so padding shows only when styled)', (width) => {
    const t = setup({ width, height: 6 })
    const lines = t.frame().split('\n')
    expect(lines.length).toBe(6)
    const available = SLASH_COMMANDS.filter((c) => !c.available || c.available(state)).length
    const shownCmds = lines.filter((l) => /^[ ›>]\s*\//.test(l)).length
    expect(lines[5]).toMatch(new RegExp(`^${available - shownCmds} more [·-] type to filter`))
    for (const l of lines) expect(textWidth(l.replace(/\s+$/, ''))).toBeLessThanOrEqual(width)
    t.r.unmount()
  })

  it('/retro on an open run answers with its reason instead of "No matching command"', async () => {
    const t = setup({ query: '/retro' })
    expect(t.frame()).not.toContain('No matching command')
    expect(t.frame()).toMatch(/\/retro: .*(Follow an ended work run|not ended)/)
    await t.send('\r')
    expect(t.props.onRun).not.toHaveBeenCalled()
    await t.send('zz')
    expect(t.frame()).toContain('No matching command')
    t.r.unmount()
  })

  it('shows the cursor as an underscore with colour off and in a screen-reader frame, and no SGR codes', () => {
    for (const env of [{ color: false }, { color: false, screenReader: true }, { color: false, unicode: false, dumbTerminal: true }]) {
      const t = setup({}, env)
      const raw = t.r.lastFrame() ?? ''
      expect(raw.split('\n')[0]).toContain('/_')
      // eslint-disable-next-line no-control-regex
      expect(raw).not.toMatch(/\x1b\[/)
      t.r.unmount()
    }
  })

  it('keeps the selection visible in a short palette', async () => {
    const t = setup({ height: 3 })
    for (let i = 0; i < 5; i++) await t.send('\x1b[B')
    const rows = t.frame().split('\n')
    expect(rows.length).toBe(3)
    expect(rows.some((r) => r.includes('›') || r.includes('>'))).toBe(true)
    t.r.unmount()
  })

  it('honors one- and two-row palette heights', () => {
    const one = setup({ height: 1 })
    expect(one.frame().split('\n')).toHaveLength(1)
    expect(one.frame()).toContain('/')
    one.r.unmount()

    const two = setup({ height: 2 })
    expect(two.frame().split('\n')).toHaveLength(2)
    expect(two.frame()).toContain('Commands')
    expect(two.frame()).toContain('/help')
    two.r.unmount()
  })
})
