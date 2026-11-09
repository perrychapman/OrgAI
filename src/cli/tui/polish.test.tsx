import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { App, type AppProps } from './App'
import { elapsedLabel, useActivityTick } from './activity'
import { Text } from 'ink'
import { project } from '../testing/fakeContext'
import { createInitialState } from './state'
import { env, key } from './panes/testUtil'
import { textWidth } from './panes/text'
import type { InputEvent, TuiEnv, TuiSessionApi } from './types'

function mount(cols: number, rows: number, onboarding = false, ordinaryNotice?: string) {
  const state = { ...createInitialState('/work/orbit'), ...(onboarding ? {} : { project: project('p1', '/work/orbit', { name: 'Orbit' }) }), connection: 'live' as const, notices: onboarding && ordinaryNotice ? [{ id: 0, text: ordinaryNotice, at: 0 }] : [] }
  const session = {
    getState: () => state, subscribe: () => () => {}, hostKind: 'daemon',
    notify: vi.fn(), submitPrompt: vi.fn(async () => {}), interrupt: vi.fn(),
    setComposeTarget: vi.fn(), resync: vi.fn()
  } as unknown as TuiSessionApi
  let receive = (_e: InputEvent) => {}
  let resize = (_c: number, _r: number) => {}
  const terminal = { size: () => ({ cols, rows }), onResize: (fn: typeof resize) => { resize = fn; return () => {} } } as AppProps['terminal']
  const app = render(<App session={session} terminal={terminal} env={env({ color: false })} launch={onboarding ? { onboarding: { folder: '/work/orbit' } } : {}} conn={{ checkPath: async () => undefined, hello: { grantedScopes: onboarding ? ['read', 'operate'] : ['read', 'operate', 'decide'] } } as unknown as AppProps['conn']} onExit={vi.fn()} input={{ subscribe: fn => { receive = fn; return () => {} } }} />)
  return { ...app, session, send: (e: InputEvent) => receive(e), resize: (c: number, r: number) => resize(c, r) }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 40))

describe('polished terminal composition', () => {
  it('starts with a welcome and usable composer, without empty team panes', async () => {
    const app = mount(120, 30)
    await flush()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Big ideas. A team to build them.')
    expect(frame).toContain('/work/orbit')
    expect(frame).toContain('What would you like your team to work on?')
    expect(frame).not.toContain('No agents yet')
    expect(frame).not.toContain('No agent worktrees')
    expect(frame.split('\n').length).toBeLessThanOrEqual(30)
    app.unmount()
  })

  it.each([[210, 45], [80, 24], [80, 20]])('keeps first-run choices and folder together at %ix%i', async (cols, rows) => {
    const app = mount(cols, rows, true)
    await flush()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('/work/orbit')
    expect(frame).toContain('[1]')
    expect(frame).toContain('[2]')
    expect(frame).toContain('[3]')
    expect(frame).not.toContain('OrgAI · Ready')
    expect(frame.split('Your workspace')).toHaveLength(1)
    expect(frame).toMatch(/OrgAI|█▀█/)
    if (cols >= 160 && rows >= 40) expect(Math.max(...frame.split('\n').map(line => textWidth(line.trim())))).toBeGreaterThan(120)
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    for (const line of frame.split('\n')) expect(textWidth(line.trimEnd())).toBeLessThanOrEqual(cols)
    app.unmount()
  })

  it('tracks the full window width on resize without moving the header into the center', async () => {
    const app = mount(207, 57, true)
    for (const [cols, rows] of [[207, 57], [280, 70], [100, 24], [160, 40]]) {
      app.resize(cols!, rows!)
      await flush()
      const lines = (app.lastFrame() ?? '').split('\n')
      const headerRow = lines.findIndex(line => line.includes('█▀█'))
      expect(headerRow).toBeLessThanOrEqual(1)
      expect(lines[headerRow]?.search(/\S/)).toBe(2)
      const rules = lines.filter(line => /^\s*[─-]{20,}\s*$/.test(line))
      expect(rules).toHaveLength(2)
      for (const rule of rules) expect(textWidth(rule.trim())).toBe(cols! - 4)
      expect(lines.findIndex(line => line.includes('Start a quick run'))).toBe(rows! - 3)
      expect(lines.length).toBe(rows)
    }
    app.unmount()
  })

  it('keeps the welcome at the top left and the composer and status at the bottom', async () => {
    const app = mount(207, 57)
    await flush()
    const lines = (app.lastFrame() ?? '').split('\n')
    expect(lines[0]?.trimStart()).toMatch(/OrgAI|✦|█/)
    expect(lines[0]?.search(/\S/)).toBe(2)
    expect(lines[0]?.trim()).toBe('█▀█ █▀█ █▀▀ ▄▀█ █')
    const prompt = lines.findIndex(line => line.includes('What would you like your team to work on?'))
    expect(prompt).toBeGreaterThan(50)
    expect(lines.at(-1)).toContain('Ready')
    app.unmount()
  })

  it('shows the latest host notice on first run', async () => {
    const app = mount(120, 35, true, 'The host restarted.')
    await flush()
    expect(app.lastFrame()).toContain('The host restarted.')
    app.unmount()
  })

  it('keeps palette and composer inside the viewport when opened and resized', async () => {
    const app = mount(120, 30)
    await flush()
    app.send(key('char', { ch: '/' }))
    await flush()
    expect(app.lastFrame()).toContain('/help')
    expect(app.lastFrame()?.split('\n').length).toBeLessThanOrEqual(30)
    app.resize(60, 16)
    await flush()
    const frame = app.lastFrame() ?? ''
    expect(frame.split('\n').length).toBeLessThanOrEqual(16)
    for (const line of frame.split('\n')) expect(textWidth(line)).toBeLessThanOrEqual(60)
    app.send(key('escape'))
    await flush()
    app.send(key('char', { ch: 'Build a tiny clock' }))
    app.send(key('enter'))
    await flush()
    expect(app.session.submitPrompt).toHaveBeenCalledWith('Build a tiny clock')
    app.unmount()
  })

  it('does not schedule motion for idle, screen-reader, dumb, no-color or reduced-motion sessions', () => {
    vi.useFakeTimers()
    function Pulse({ active, environment }: { active: boolean; environment: TuiEnv }) {
      const tick = useActivityTick(active, environment)
      return <Text>{tick}</Text>
    }
    try {
      for (const environment of [env({ reducedMotion: true }), env({ screenReader: true }), env({ dumbTerminal: true }), env({ color: false })]) {
        const app = render(<Pulse active environment={environment} />)
        const before = app.lastFrame()
        vi.advanceTimersByTime(1000)
        expect(app.lastFrame()).toBe(before)
        app.unmount()
      }
      const app = render(<Pulse active={false} environment={env()} />)
      vi.advanceTimersByTime(1000)
      expect(app.lastFrame()).toBe('0')
      app.unmount()
    } finally { vi.useRealTimers() }
  })

  it('formats elapsed work without negative times', () => {
    expect(elapsedLabel(0, 65_000)).toBe('1m 5s')
    expect(elapsedLabel(0, 3_661_000)).toBe('1h 1m')
    expect(elapsedLabel(10_000, 0)).toBe('0s')
  })
})
