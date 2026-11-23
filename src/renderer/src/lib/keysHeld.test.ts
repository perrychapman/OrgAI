import { describe, expect, it, vi } from 'vitest'
import { createKeyTracker, focusIsFree } from './keysHeld'

const key = (target: EventTarget, type: 'keydown' | 'keyup', code: string): void => {
  target.dispatchEvent(Object.assign(new Event(type), { code }))
}

describe('key tracker (no decision is answered by a key that began before the action had focus)', () => {
  it('runs a deferred focus move at once when no key is down', () => {
    const t = new EventTarget()
    const k = createKeyTracker(t)
    const fn = vi.fn()
    k.whenReleased(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(k.held()).toBe(false)
  })

  it('waits for the last key-up, through key repeats, and runs once', () => {
    const t = new EventTarget()
    const k = createKeyTracker(t)
    const fn = vi.fn()
    key(t, 'keydown', 'Enter')
    key(t, 'keydown', 'Enter')
    expect(k.held()).toBe(true)
    k.whenReleased(fn)
    key(t, 'keydown', 'Enter')
    expect(fn).not.toHaveBeenCalled()
    key(t, 'keyup', 'Enter')
    expect(fn).toHaveBeenCalledTimes(1)
    key(t, 'keydown', 'Enter')
    key(t, 'keyup', 'Enter')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('needs every held key up (Ctrl+. keeps the move waiting after the dot is released)', () => {
    const t = new EventTarget()
    const k = createKeyTracker(t)
    const fn = vi.fn()
    key(t, 'keydown', 'ControlLeft')
    key(t, 'keydown', 'Period')
    k.whenReleased(fn)
    key(t, 'keyup', 'Period')
    expect(fn).not.toHaveBeenCalled()
    key(t, 'keyup', 'ControlLeft')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a cancelled move never runs, and a window blur clears the held keys', () => {
    const t = new EventTarget()
    const k = createKeyTracker(t)
    const fn = vi.fn()
    key(t, 'keydown', 'Enter')
    const cancel = k.whenReleased(fn)
    cancel()
    key(t, 'keyup', 'Enter')
    expect(fn).not.toHaveBeenCalled()
    key(t, 'keydown', 'Enter')
    t.dispatchEvent(new Event('blur'))
    expect(k.held()).toBe(false)
  })

  it('focus is free when nowhere, on the body, or still on what the move itself left it on', () => {
    const body = {}
    const opener = {}
    const landing = {}
    const other = {}
    expect(focusIsFree(null, body)).toBe(true)
    expect(focusIsFree(body, body)).toBe(true)
    expect(focusIsFree(opener, body, [opener, landing])).toBe(true)
    expect(focusIsFree(landing, body, [opener, landing])).toBe(true)
    expect(focusIsFree(other, body, [opener, landing])).toBe(false)
    expect(focusIsFree(other, body)).toBe(false)
    expect(focusIsFree(other, body, [null, undefined])).toBe(false)
  })
})
