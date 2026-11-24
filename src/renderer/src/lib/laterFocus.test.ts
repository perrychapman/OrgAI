import { describe, expect, it } from 'vitest'
import { mayRestoreFocus } from './laterFocus'

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
