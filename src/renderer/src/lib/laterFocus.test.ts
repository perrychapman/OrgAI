import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusAfterUnlessMoved, mayRestoreFocus } from './laterFocus'

const body = { id: 'body' }
const el = (isConnected = true): { isConnected: boolean } => ({ isConnected })

describe('mayRestoreFocus', () => {
  it('restores when focus is still on the control the handler ran from', () => {
    const from = el()
    expect(mayRestoreFocus(from, from, body)).toBe(true)
  })

  it('restores when the re-insert dropped focus to the page', () => {
    expect(mayRestoreFocus(el(), body, body)).toBe(true)
    expect(mayRestoreFocus(el(), null, body)).toBe(true)
  })

  it('restores when the control the handler ran from left the page', () => {
    expect(mayRestoreFocus(el(false), el(), body)).toBe(true)
  })

  it('does not pull the person back after they moved focus to another control', () => {
    expect(mayRestoreFocus(el(), el(), body)).toBe(false)
  })

  it('does not take focus when nothing had it and the person has since put it somewhere', () => {
    expect(mayRestoreFocus(null, el(), body)).toBe(false)
  })
})

describe('focusAfterUnlessMoved', () => {
  interface Fake {
    isConnected: boolean
    focus: ReturnType<typeof vi.fn>
  }
  const fake = (): Fake => ({ isConnected: true, focus: vi.fn() })
  const setup = (active: unknown): { doc: { activeElement: unknown; body: unknown } } => {
    vi.useFakeTimers()
    const doc = { activeElement: active, body: {} }
    if (active === null) doc.activeElement = doc.body
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout })
    return { doc }
  }
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('hands focus back when nothing moved it in the meantime', () => {
    setup(null)
    const back = fake()
    focusAfterUnlessMoved(() => back as unknown as HTMLElement, 0)
    vi.advanceTimersByTime(5)
    expect(back.focus).toHaveBeenCalledTimes(1)
  })

  it('does not pull the person out of what they moved on to (a reopened composer, a late timer)', () => {
    const opener = fake()
    const { doc } = setup(opener)
    focusAfterUnlessMoved(() => opener as unknown as HTMLElement, 0)
    doc.activeElement = fake() // the composer opened again and its field took focus
    vi.advanceTimersByTime(5)
    expect(opener.focus).not.toHaveBeenCalled()
  })

  it('hands focus back when the control it ran from left the page', () => {
    const gone = fake()
    const back = fake()
    const { doc } = setup(gone)
    focusAfterUnlessMoved(() => back as unknown as HTMLElement, 0)
    gone.isConnected = false
    doc.activeElement = fake()
    vi.advanceTimersByTime(5)
    expect(back.focus).toHaveBeenCalledTimes(1)
  })
})
