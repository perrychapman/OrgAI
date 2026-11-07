import { render } from 'ink-testing-library'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { InputBus } from './context'
import { MotionRule, Shimmer, Spinner, shimmerColor } from './Motion'
import { ESC_RE, Providers, env, withInkColor } from './panes/testUtil'

describe('Motion', () => {
  function luminance(hex: string): number {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    const linear = channels.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  }

  function contrast(a: string, b: string): number {
    const first = luminance(a)
    const second = luminance(b)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
  }

  it('keeps the sweep bounded and phase-addressable', () => {
    expect(shimmerColor(0, 0)).toBe(shimmerColor(0, 20))
    expect(shimmerColor(0, 0)).not.toBe(shimmerColor(0, 4))
    expect(shimmerColor(0, 0)).toMatch(/^#(?:[0-9a-f]{6})$/)
  })

  it('keeps every sweep color readable on light and dark terminal backgrounds', () => {
    const colors = new Set(Array.from({ length: 20 }, (_, phase) => shimmerColor(0, phase)))
    for (const color of colors) {
      expect(contrast(color, '#ffffff')).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color, '#000000')).toBeGreaterThanOrEqual(3.8)
    }
  })

  it('shares an explicit phase without scheduling a second timer', async () => {
    await withInkColor(() => {
      const one = render(
        <Providers env={env()} bus={new InputBus()}>
          <Shimmer text="OrgAI" active={false} phase={0} />
        </Providers>
      )
      const two = render(
        <Providers env={env()} bus={new InputBus()}>
          <Shimmer text="OrgAI" active={false} phase={4} />
        </Providers>
      )
      expect(shimmerColor(0, 0)).not.toBe(shimmerColor(0, 4))
      expect(one.lastFrame()).toContain('OrgAI')
      one.unmount()
      two.unmount()
    })
  })

  it('uses plain accessible output and a static spinner without color', () => {
    for (const environment of [env({ color: false }), env({ screenReader: true }), env({ dumbTerminal: true })]) {
      const app = render(
        <Providers env={environment} bus={new InputBus()}>
          <Shimmer text="OrgAI" active={false} phase={3} />
          <Spinner label="Working" active={false} phase={3} />
        </Providers>
      )
      expect(app.lastFrame()).toContain('OrgAI')
      expect(app.lastFrame()).toContain('Working')
      expect(app.lastFrame()).not.toMatch(ESC_RE)
      app.unmount()
    }
  })

  it.each(['dark', 'light'] as const)('uses readable foregrounds instead of dimming %s thinking text', async (terminalTheme) => {
    await withInkColor(() => {
      const app = render(<Providers env={env({ terminalTheme })} bus={new InputBus()}><Shimmer text="Thinking" active={false} phase={4} /></Providers>)
      const frame = app.lastFrame() ?? ''
      expect(frame.replace(/\x1b\[[0-9;]*m/g, '')).toBe('Thinking')
      expect(frame).not.toContain('\x1b[2m')
      app.unmount()
    })
  })

  it('keeps a moving rule at its exact cell width and preserves the prompt label', () => {
    const frame = '┌─ Reply ' + '─'.repeat(70) + '┐'
    const app = render(<Providers env={env()} bus={new InputBus()}><MotionRule width={80} text={frame} active={false} phase={20} /></Providers>)
    expect((app.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '')).toBe(frame)
    app.unmount()
  })

  it('advances genuine spinner work and cleans up on unmount', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    try {
      let app!: ReturnType<typeof render>
      await act(async () => {
        app = render(<Providers env={env()} bus={new InputBus()}><Spinner label="Working" /></Providers>)
      })
      const before = app.lastFrame()
      await act(async () => {
        vi.advanceTimersByTime(240)
        await Promise.resolve()
      })
      expect(app.lastFrame()).not.toBe(before)
      await act(async () => { app.unmount() })
      vi.advanceTimersByTime(1000)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
