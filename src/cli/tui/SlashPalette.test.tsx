import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBus, InputBusContext } from './context'
import { KeyParser } from './input/keys'
import { SLASH_COMMANDS } from './slashCommands'
import { SlashPalette } from './SlashPalette'
import type { InputEvent, SlashPaletteProps, TuiState } from './types'

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

function setup(over: Partial<SlashPaletteProps> = {}) {
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
    <InputBusContext.Provider value={bus}>
      <SlashPalette {...props} />
    </InputBusContext.Provider>
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
    expect(t.frame()).toContain('/help')
    expect(t.frame()).toContain('/quit')
    // interrupt / stop need an open active run.
    expect(t.frame()).not.toContain('/interrupt')
    await t.send('ru')
    const f = t.frame()
    expect(f.split('\n')[0]).toContain('/ru')
    expect(f).toContain('/run')
    expect(f).toContain('/runs')
    expect(f).not.toContain('/help')
    await t.send('zz')
    expect(t.frame()).toContain('No matching command')
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
    expect(t.frame().split('\n')[0].trim()).toBe('/new')
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
    expect(u.frame().split('\n')[0].trim()).toBe('/')
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

  it('keeps the selection visible in a short palette', async () => {
    const t = setup({ height: 3 })
    for (let i = 0; i < 5; i++) await t.send('\x1b[B')
    const rows = t.frame().split('\n')
    expect(rows.length).toBe(3)
    expect(rows.some((r) => r.includes('›') || r.includes('>'))).toBe(true)
    t.r.unmount()
  })
})
