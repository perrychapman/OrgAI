import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { InputBus, InputBusContext, TuiEnvContext, useFocusHandler, useTuiEnv, DEFAULT_TUI_ENV } from './context'
import type { FocusTarget, InputEvent, InputHandler, TuiEnv } from './types'

const key = (ch: string): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch })

function Listener(props: { target: FocusTarget; handler: InputHandler; active?: boolean }) {
  useFocusHandler(props.target, props.handler, props.active)
  return <Text>listening</Text>
}

describe('InputBus', () => {
  it('dispatches only to the focused target', () => {
    const bus = new InputBus()
    const composer = vi.fn(() => true)
    const tray = vi.fn(() => true)
    bus.register('composer', composer)
    bus.register('tray', tray)
    expect(bus.dispatch(key('y'), 'composer')).toBe(true)
    expect(composer).toHaveBeenCalledTimes(1)
    expect(tray).not.toHaveBeenCalled()
    expect(bus.dispatch(key('y'), 'palette')).toBe(false)
  })

  it('lets the newest registration per target win and falls back when it leaves', () => {
    const bus = new InputBus()
    const older = vi.fn(() => true)
    const newer = vi.fn(() => false)
    bus.register('tray', older)
    const off = bus.register('tray', newer)
    expect(bus.dispatch(key('a'), 'tray')).toBe(false)
    expect(newer).toHaveBeenCalledTimes(1)
    expect(older).not.toHaveBeenCalled()
    off()
    off()
    expect(bus.dispatch(key('a'), 'tray')).toBe(true)
    expect(older).toHaveBeenCalledTimes(1)
  })
})

describe('useFocusHandler', () => {
  it('receives events only while its target is focused, and unmount unregisters', () => {
    const bus = new InputBus()
    const handler = vi.fn(() => true)
    const r = render(
      <InputBusContext.Provider value={bus}>
        <Listener target="composer" handler={handler} />
      </InputBusContext.Provider>
    )
    expect(bus.dispatch(key('x'), 'tray')).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(bus.dispatch(key('x'), 'composer')).toBe(true)
    expect(handler).toHaveBeenCalledWith(key('x'))
    r.unmount()
    expect(bus.has('composer')).toBe(false)
    expect(bus.dispatch(key('x'), 'composer')).toBe(false)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not register while inactive', () => {
    const bus = new InputBus()
    const r = render(
      <InputBusContext.Provider value={bus}>
        <Listener target="composer" handler={() => true} active={false} />
      </InputBusContext.Provider>
    )
    expect(bus.has('composer')).toBe(false)
    r.unmount()
  })

  it('always calls the latest handler without re-registering', () => {
    const bus = new InputBus()
    const register = vi.spyOn(bus, 'register')
    const seen: string[] = []
    let bump: (() => void) | undefined
    function Counter() {
      const [n, setN] = useState(0)
      bump = () => setN((v) => v + 1)
      useFocusHandler('composer', () => {
        seen.push(`v${n}`)
        return true
      })
      return <Text>{n}</Text>
    }
    const r = render(
      <InputBusContext.Provider value={bus}>
        <Counter />
      </InputBusContext.Provider>
    )
    bus.dispatch(key('a'), 'composer')
    bump?.()
    r.rerender(
      <InputBusContext.Provider value={bus}>
        <Counter />
      </InputBusContext.Provider>
    )
    bus.dispatch(key('b'), 'composer')
    expect(seen).toEqual(['v0', 'v1'])
    expect(register).toHaveBeenCalledTimes(1)
    r.unmount()
  })
})

describe('TuiEnvContext', () => {
  it('provides the env, with safe defaults', () => {
    function Show() {
      const env = useTuiEnv()
      return <Text>{`${env.bufferMode} ${env.color}`}</Text>
    }
    const custom: TuiEnv = { ...DEFAULT_TUI_ENV, bufferMode: 'fullscreen', color: true }
    const a = render(<Show />)
    expect(a.lastFrame()).toBe('inline false')
    a.unmount()
    const b = render(
      <TuiEnvContext.Provider value={custom}>
        <Show />
      </TuiEnvContext.Provider>
    )
    expect(b.lastFrame()).toBe('fullscreen true')
    b.unmount()
  })
})
