import { render } from 'ink-testing-library'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Brand, brandHeight } from './Brand'
import { InputBus } from './context'
import { Providers, env, ESC_RE, inkChalk } from './panes/testUtil'
import { terminalPalette } from './theme'
import type { TuiEnv } from './types'

describe('Brand', () => {
  it('keeps the compact wordmark text stable and uses one-line fallback geometry', () => {
    const app = render(<Providers env={env()} bus={new InputBus()}><Brand width={32} version="v1.2.3" /></Providers>)
    expect(app.lastFrame()).toContain('✦ OrgAI  v1.2.3')
    expect(brandHeight(32, env(), true)).toBe(1)
    app.unmount()
  })

  it('uses theme-aware brand colors with readable contrast', () => {
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map((v) => {
        const c = parseInt(v, 16) / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    for (const terminalTheme of ['dark', 'light'] as const) {
      const palette = terminalPalette({ terminalTheme })
      const background = terminalTheme === 'dark' ? '#181c27' : '#ffffff'
      const contrast = (Math.max(luminance(palette.brandBase), luminance(background)) + 0.05) /
        (Math.min(luminance(palette.brandBase), luminance(background)) + 0.05)
      const accentContrast = (Math.max(luminance(palette.accent), luminance(background)) + 0.05) /
        (Math.min(luminance(palette.accent), luminance(background)) + 0.05)
      expect(contrast, terminalTheme).toBeGreaterThanOrEqual(4.5)
      expect(accentContrast, `${terminalTheme} shimmer`).toBeGreaterThanOrEqual(4.5)
    }
    expect(terminalPalette({ terminalTheme: 'dark' }).brandBase).toBe('#ffffff')
    expect(terminalPalette({ terminalTheme: 'light' }).brandBase).toBe('#12151f')
  })

  it('runs one restrained prominent sweep and cleans up its timer', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const chalk = await inkChalk()
    const previousLevel = chalk?.level
    if (chalk) chalk.level = 3
    try {
      let app!: ReturnType<typeof render>
      await act(async () => {
          app = render(<Providers env={env()} bus={new InputBus()}><Brand width={60} prominent animated /></Providers>)
      })
      // The sweep window: the phase timeout plus the one shared 120 ms tick interval.
      expect(vi.getTimerCount()).toBe(2)
      const before = app.lastFrame()
      await act(async () => {
        vi.advanceTimersByTime(800)
        await Promise.resolve()
      })
      expect(app.lastFrame()).not.toBe(before)
      await act(async () => { vi.advanceTimersByTime(1_200) })
      const resting = app.lastFrame()
      // The static idle window holds no frame loop: only the timeout that starts the next sweep.
      expect(vi.getTimerCount()).toBe(1)
      expect(resting).toBe(before)
      await act(async () => { vi.advanceTimersByTime(3_000) })
      expect(app.lastFrame()).toBe(resting)
      await act(async () => { vi.advanceTimersByTime(1_500) })
      expect(app.lastFrame()).not.toBe(resting)
      await act(async () => { app.unmount() })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      if (chalk && previousLevel !== undefined) chalk.level = previousLevel
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  const staticModes: Array<[string, Partial<TuiEnv>]> = [
    ['reduced motion', { reducedMotion: true }],
    ['no color', { color: false }],
    ['screen reader', { screenReader: true }],
    ['dumb terminal', { dumbTerminal: true }],
    ['inline', { bufferMode: 'inline' as const }]
  ]

  it.each(staticModes)('stays static for %s', async (_name, over) => {
    vi.useFakeTimers()
    try {
      const app = render(<Providers env={env(over)} bus={new InputBus()}><Brand width={60} prominent animated /></Providers>)
      const before = app.lastFrame()
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => {
        vi.advanceTimersByTime(1_500)
        await Promise.resolve()
      })
      expect(app.lastFrame()).toBe(before)
      if (over.color === false || over.screenReader || over.dumbTerminal) expect(app.lastFrame()).not.toMatch(ESC_RE)
      app.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
