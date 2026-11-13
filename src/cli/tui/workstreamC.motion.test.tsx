import { render } from 'ink-testing-library'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TICK_MS, subscribeTick, tickSubscriberCount, useActivityTick } from './activity'
import { InputBus, useTuiEnv } from './context'
import { shimmerSpans } from './Motion'
import { Providers, env } from './panes/testUtil'
import { Text } from 'ink'

const palette = { primary: '#ffffff', secondary: '#888888' }

describe('shared tick', () => {
  it('runs one interval only while subscribed and clears it at zero subscribers', () => {
    vi.useFakeTimers()
    try {
      expect(vi.getTimerCount()).toBe(0)
      const a = vi.fn()
      const b = vi.fn()
      const offA = subscribeTick(a)
      const offB = subscribeTick(b)
      expect(vi.getTimerCount()).toBe(1)
      expect(tickSubscriberCount()).toBe(2)
      vi.advanceTimersByTime(TICK_MS * 2)
      expect(a).toHaveBeenCalledTimes(2)
      expect(b).toHaveBeenCalledTimes(2)
      offA()
      expect(vi.getTimerCount()).toBe(1)
      offB()
      expect(vi.getTimerCount()).toBe(0)
      expect(tickSubscriberCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is 120 ms', () => expect(TICK_MS).toBe(120))

  it('useActivityTick subscribes only when active and motion is allowed (reduced motion: no timer)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    try {
      function Probe({ active }: { active: boolean }) {
        const t = useActivityTick(active, useTuiEnv())
        return <Text>t{t}</Text>
      }
      let app!: ReturnType<typeof render>
      await act(async () => {
        app = render(<Providers env={env({ reducedMotion: true })} bus={new InputBus()}><Probe active /></Providers>)
      })
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => app.unmount())
      await act(async () => {
        app = render(<Providers env={env()} bus={new InputBus()}><Probe active /></Providers>)
      })
      expect(vi.getTimerCount()).toBe(1)
      await act(async () => {
        vi.advanceTimersByTime(TICK_MS)
      })
      expect(app.lastFrame()).toContain('t1')
      await act(async () => app.unmount())
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe('Shimmer spans', () => {
  it('groups contiguous characters of one color into single spans', () => {
    const text = 'Reading files from the repository'
    const spans = shimmerSpans(text, 3, true, palette)
    expect(spans.map((s) => s.text).join('')).toBe(text)
    expect(spans.length).toBeLessThan(Array.from(text).length)
    for (let i = 1; i < spans.length; i++) expect(spans[i].color === spans[i - 1].color && spans[i].bold === spans[i - 1].bold).toBe(false)
  })
})
