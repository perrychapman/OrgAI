import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { Composer, COMPOSER_MAX_ROWS, promptGlyph, type ComposerViewProps } from './Composer'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from './context'
import { KeyParser } from './input/keys'
import type { ComposerMode, InputEvent, TuiEnv } from './types'
import { withInkColor } from './panes/testUtil'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
// eslint-disable-next-line no-control-regex
const plain = (s: string | undefined) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')

const keys = (s: string): InputEvent[] => {
  const p = new KeyParser({ bracketedPaste: true })
  return [...p.feed(s), ...p.flush()]
}

function setup(over: Partial<ComposerViewProps> = {}, environment: Partial<TuiEnv> = {}) {
  const bus = new InputBus()
  const props: ComposerViewProps = {
    width: 40,
    focused: true,
    mode: 'send' as ComposerMode,
    placeholder: 'Message the team',
    onSubmit: vi.fn(),
    onOpenPalette: vi.fn(),
    onLeave: vi.fn(),
    ...over
  }
  const r = render(
    <TuiEnvContext.Provider value={{ ...DEFAULT_TUI_ENV, ...environment }}>
      <InputBusContext.Provider value={bus}>
        <Composer {...props} />
      </InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
  const send = async (s: string | InputEvent): Promise<boolean[]> => {
    const evs = typeof s === 'string' ? keys(s) : [s]
    const out = evs.map((e) => bus.dispatch(e, 'composer'))
    await tick()
    return out
  }
  return { bus, props, r, send, frame: () => plain(r.lastFrame()) }
}

describe('Composer', () => {
  it('inserts decision letters and digits literally', async () => {
    const t = setup()
    const consumed = await t.send('ysanmhxrpl0123456789 ')
    expect(consumed.every(Boolean)).toBe(true)
    await t.send('\r')
    expect(t.props.onSubmit).toHaveBeenCalledWith('ysanmhxrpl0123456789')
    t.r.unmount()
  })

  it('a paste with newlines does not submit and inserts lines', async () => {
    const t = setup()
    expect(await t.send({ type: 'paste', text: 'y\nsecond line\n' })).toEqual([true])
    expect(t.props.onSubmit).not.toHaveBeenCalled()
    expect(t.frame()).toContain('y')
    expect(t.frame()).toContain('second line')
    expect(t.frame().split('\n').length).toBeGreaterThanOrEqual(3)
    t.r.unmount()
  })

  it('Enter submits the trimmed text and clears; empty Enter does nothing', async () => {
    const t = setup()
    await t.send('\r')
    expect(t.props.onSubmit).not.toHaveBeenCalled()
    await t.send('   ')
    await t.send('\r')
    expect(t.props.onSubmit).not.toHaveBeenCalled()
    await t.send('\x15') // Ctrl+U
    await t.send('  hello  \r')
    expect(t.props.onSubmit).toHaveBeenCalledWith('hello')
    expect(t.frame()).toContain('Message the team')
    t.r.unmount()
  })

  it('Alt+Enter and Ctrl+J insert a newline', async () => {
    const t = setup()
    await t.send('a\x1b\rb\x1b[106;5uc\r')
    expect(t.props.onSubmit).toHaveBeenCalledWith('a\nb\nc')
    t.r.unmount()
  })

  it("'/' on an empty buffer opens the palette; elsewhere it is literal", async () => {
    const t = setup()
    await t.send('/')
    expect(t.props.onOpenPalette).toHaveBeenCalledWith('/')
    expect(t.frame()).toContain('Message the team')
    await t.send('a/b\r')
    expect(t.props.onOpenPalette).toHaveBeenCalledTimes(1)
    expect(t.props.onSubmit).toHaveBeenCalledWith('a/b')
    t.r.unmount()
  })

  it('Shift+Tab calls onLeave; Esc and Tab are not consumed', async () => {
    const t = setup()
    expect(await t.send('\x1b[Z')).toEqual([true])
    expect(t.props.onLeave).toHaveBeenCalledTimes(1)
    expect(await t.send('\x1b')).toEqual([false])
    expect(await t.send('\t')).toEqual([false])
    expect(await t.send('\x1bd')).toEqual([false]) // Alt+D is the shell's
    t.r.unmount()
  })

  it('Ctrl+C clears a non-empty buffer, then is not consumed', async () => {
    const t = setup()
    await t.send('draft')
    expect(t.frame()).toContain('draft')
    expect(await t.send('\x03')).toEqual([true])
    expect(t.frame()).not.toContain('draft')
    expect(await t.send('\x03')).toEqual([false])
    expect(await t.send('\x1a')).toEqual([false]) // Ctrl+Z is the shell's
    t.r.unmount()
  })

  it('readOnly never submits and shows the reason', async () => {
    const t = setup({ mode: 'readOnly', disabledReason: 'Read only: \x1b[31mthe host\x1b[0m is draining' })
    expect(t.frame()).toContain('Read only: the host is draining')
    await t.send('hello\r')
    expect(t.props.onSubmit).not.toHaveBeenCalled()
    t.r.unmount()
  })

  it('edits with the cursor: left, insert, backspace, delete', async () => {
    const t = setup()
    await t.send('acd')
    await t.send('\x1b[D\x1b[D') // two left
    await t.send('b')
    await t.send('\x1b[3~') // delete 'c'
    await t.send('\x01') // Ctrl+A
    await t.send('>')
    await t.send('\x05\x7f') // Ctrl+E, backspace
    await t.send('\r')
    expect(t.props.onSubmit).toHaveBeenCalledWith('>ab')
    t.r.unmount()
  })

  it('wraps to the width and shows at most COMPOSER_MAX_ROWS rows', async () => {
    const t = setup({ width: 13 }) // one column is kept for the glyph cursor (colour is off here)
    await t.send('abcdefghijklmnop')
    const rows = t.frame().split('\n')
    expect(rows.length).toBe(2)
    expect(rows[0]).toContain('abcdefghij')
    expect(rows[1].trim()).toBe('klmnop|')
    await t.send({ type: 'paste', text: '\n1\n2\n3\n4\n5\n6\n7' })
    const many = t.frame().split('\n')
    expect(many.length).toBe(COMPOSER_MAX_ROWS)
    expect(many[many.length - 1].trim()).toBe('7|')
    t.r.unmount()
  })

  it('shows the mode glyph and does not register while unfocused', async () => {
    const t = setup({ focused: false, mode: 'start' })
    expect(t.bus.has('composer')).toBe(false)
    expect(t.frame()).toMatch(/^> /)
    t.r.unmount()
  })

  it('uses clean prompt glyphs for unicode and ASCII terminals', () => {
    expect(promptGlyph('send', false)).toBe('›')
    expect(promptGlyph('start', false)).toBe('›')
    expect(promptGlyph('send', true)).toBe('>')
  })

  it('uses a padded borderless input with hints underneath in the reserved height', () => {
    const t = setup({ height: 5, hints: 'Enter sends | Esc interrupts' })
    const rows = t.frame().split('\n')
    expect(rows).toHaveLength(5)
    expect(rows[0].trim()).toBe('')
    expect(rows[1]).toMatch(/^  > /)
    expect(rows[2].trim()).toBe('')
    expect(rows[3].trim()).toBe('')
    expect(rows[4]).toContain('Enter sends')
    expect(rows.every((row) => row.length <= 40)).toBe(true)
    t.r.unmount()
  })

  it('keeps focused, working, read-only and unfocused inputs still and unlabelled', () => {
    const focused = setup({ height: 5, animated: true })
    const working = setup({ height: 5, working: true, animated: true })
    const readOnly = setup({ height: 5, mode: 'readOnly', disabledReason: 'Host is draining', animated: true })
    const unfocused = setup({ height: 5, focused: false, mode: 'start', animated: true })
    expect(focused.frame().split('\n')).toHaveLength(5)
    expect(working.frame().split('\n')).toHaveLength(5)
    expect(readOnly.frame().split('\n')).toHaveLength(5)
    expect(unfocused.frame().split('\n')).toHaveLength(5)
    expect(focused.frame()).not.toContain('Reply')
    expect(readOnly.frame()).toContain('Host is draining')
    expect(unfocused.frame()).not.toContain('New run')
    focused.r.unmount()
    working.r.unmount()
    readOnly.r.unmount()
    unfocused.r.unmount()
  })

  it('uses the spare padding for multiline input without growing the five-row layout', async () => {
    const t = setup({ width: 60, height: 5 })
    await t.send({ type: 'paste', text: 'first\nsecond\nthird' })
    expect(t.frame().split('\n')).toHaveLength(5)
    for (const text of ['first', 'second', 'third']) expect(t.frame()).toContain(text)
    expect(t.props.onSubmit).not.toHaveBeenCalled()
    t.r.unmount()
  })

  it.each(['dark', 'light'] as const)('paints a paired %s input surface and readable text', async (terminalTheme) => {
    await withInkColor(async () => {
      const t = setup({ width: 60, height: 5 }, { color: true, unicode: true, terminalTheme })
      const initial = t.r.lastFrame() ?? ''
      expect(initial).toContain(terminalTheme === 'dark' ? '\x1b[40m' : '\x1b[107m')
      await t.send('Visible text')
      const typed = t.r.lastFrame() ?? ''
      expect(typed).toContain(terminalTheme === 'dark' ? '\x1b[97m' : '\x1b[30m')
      expect(t.frame()).toContain('Visible text')
      expect(t.frame().split('\n')).toHaveLength(5)
      t.r.unmount()
    })
  })

  it('auto-bands fullscreen composition and grows through six wrapped text rows', async () => {
    const onRows = vi.fn()
    const t = setup({ onRows }, { bufferMode: 'fullscreen', unicode: true })
    expect(t.frame().split('\n')).toHaveLength(5)
    expect(onRows).toHaveBeenLastCalledWith(5)
    await t.send({ type: 'paste', text: 'one\ntwo\nthree\nfour\nfive\nsix' })
    expect(t.frame().split('\n')).toHaveLength(10)
    expect(t.frame()).toContain('six')
    expect(onRows).toHaveBeenLastCalledWith(10)
    t.r.unmount()
  })

  it('clamps the fullscreen auto-band to maxHeight while keeping the cursor visible', async () => {
    const onRows = vi.fn()
    const t = setup({ maxHeight: 6, onRows }, { bufferMode: 'fullscreen', unicode: true })
    await t.send({ type: 'paste', text: 'one\ntwo\nthree\nfour\nfive\nsix' })
    expect(t.frame().split('\n')).toHaveLength(6)
    expect(t.frame()).toContain('six')
    expect(onRows).toHaveBeenLastCalledWith(6)
    t.r.unmount()
  })

  it('keeps inline and compact heights unframed and cursor-visible', async () => {
    const inline = setup({ height: 1 })
    await inline.send('one\ntwo')
    expect(inline.frame().split('\n')).toHaveLength(1)
    expect(inline.frame()).not.toContain('+--')
    inline.r.unmount()

    const compact = setup({ width: 14, height: 2 })
    expect(compact.frame().split('\n')).toHaveLength(2)
    await compact.send({ type: 'paste', text: 'one\ntwo\nthree' })
    const rows = compact.frame().split('\n')
    expect(rows).toHaveLength(2)
    expect(compact.frame()).toContain('three')
    compact.r.unmount()
  })

  it('keeps a multiline cursor visible after a height reduction', async () => {
    const t = setup({ width: 14, height: 5 })
    await t.send({ type: 'paste', text: 'one\ntwo\nthree\nfour' })
    expect(t.frame()).toContain('four')
    t.props.height = 3
    t.r.rerender(
      <TuiEnvContext.Provider value={DEFAULT_TUI_ENV}>
        <InputBusContext.Provider value={t.bus}>
          <Composer {...t.props} />
        </InputBusContext.Provider>
      </TuiEnvContext.Provider>
    )
    expect(t.frame().split('\n')).toHaveLength(3)
    expect(t.frame()).toContain('four')
    t.r.unmount()
  })

  it('renders a plain unicode prompt without color escapes or borders', () => {
    const t = setup({ height: 3, hints: 'Enter sends' }, { bufferMode: 'fullscreen', unicode: true, color: false })
    expect(t.frame()).not.toContain('┌')
    expect(t.frame()).toContain('›')
    expect(t.frame()).not.toMatch(/\x1b\[/)
    t.r.unmount()
  })

  it('draws a glyph cursor when colour is off, and reports its rows', async () => {
    const onRows = vi.fn()
    const t = setup({ onRows })
    expect(t.frame()).toContain('|')
    expect(onRows).toHaveBeenLastCalledWith(1)
    await t.send({ type: 'paste', text: '\n1\n2' })
    expect(onRows).toHaveBeenLastCalledWith(3)
    t.r.unmount()
  })

  it('a lone ? on an empty composer calls onHelp; with text it is a character', async () => {
    const onHelp = vi.fn()
    const t = setup({ onHelp })
    await t.send('?')
    expect(onHelp).toHaveBeenCalledTimes(1)
    await t.send('a?')
    expect(onHelp).toHaveBeenCalledTimes(1)
    expect(t.frame()).toContain('a?')
    t.r.unmount()
  })

  it('without onHelp ? types', async () => {
    const t = setup()
    await t.send('?')
    expect(t.frame()).toContain('?')
    t.r.unmount()
  })
})
