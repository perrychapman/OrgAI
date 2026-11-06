import { describe, expect, it } from 'vitest'
import { targetScrollTop } from './scrollWithin'

const m = { current: 100, targetTop: 300, targetHeight: 50, clientHeight: 600, scrollHeight: 2000 }

describe('targetScrollTop', () => {
  it('puts the target at the top, clamped to the scroll range', () => {
    expect(targetScrollTop('start', m)).toBe(400)
    expect(targetScrollTop('start', { ...m, targetTop: 1800 })).toBe(1400)
    expect(targetScrollTop('start', { ...m, current: 0, targetTop: -50 })).toBe(0)
  })
  it('centres the target', () => {
    expect(targetScrollTop('center', m)).toBe(125)
  })
  it('nearest leaves a visible target alone and reveals a hidden one', () => {
    expect(targetScrollTop('nearest', m)).toBe(100)
    expect(targetScrollTop('nearest', { ...m, targetTop: -20 })).toBe(80)
    expect(targetScrollTop('nearest', { ...m, targetTop: 700 })).toBe(250)
  })
  it('never scrolls a container that does not overflow', () => {
    expect(targetScrollTop('start', { ...m, current: 0, scrollHeight: 600 })).toBe(0)
  })
})
