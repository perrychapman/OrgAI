import { describe, expect, it } from 'vitest'
import { AppBehaviour, closeActionFor, type AppBehaviourDeps, type AppBehaviourSettings } from './appBehaviour'

interface Rig {
  b: AppBehaviour
  settings: AppBehaviourSettings
  state: { live: number; os: boolean; throwOnSet: boolean; nextId: number; started: Set<number> }
  calls: { set: boolean[]; start: number; stop: number[] }
  logs: string[]
  timers: (() => void)[]
  fire(): void
}

function rig(over: Partial<AppBehaviourDeps> = {}, initial: AppBehaviourSettings = {}): Rig {
  const settings: AppBehaviourSettings = { ...initial }
  const state = { live: 0, os: false, throwOnSet: false, nextId: 1, started: new Set<number>() }
  const calls = { set: [] as boolean[], start: 0, stop: [] as number[] }
  const logs: string[] = []
  const timers: (() => void)[] = []
  const b = new AppBehaviour({
    platform: 'win32',
    packaged: true,
    settings: () => settings,
    liveRuns: () => state.live,
    loginItem: {
      get: () => state.os,
      set: (v) => {
        if (state.throwOnSet) throw new Error('denied')
        calls.set.push(v)
        state.os = v
      }
    },
    powerBlocker: {
      start: () => {
        calls.start++
        const id = state.nextId++
        state.started.add(id)
        return id
      },
      stop: (id) => {
        calls.stop.push(id)
        state.started.delete(id)
      },
      isStarted: (id) => state.started.has(id)
    },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {
      timers.length = 0
    },
    ...over
  })
  return {
    b,
    settings,
    state,
    calls,
    logs,
    timers,
    fire: () => {
      const fn = timers.shift()
      fn?.()
    }
  }
}

describe('openAtLogin', () => {
  it('turns the login item on at startup when the setting is on and the OS says off', () => {
    const r = rig({}, { openAtLogin: true })
    r.b.start()
    expect(r.calls.set).toEqual([true])
  })

  it('writes nothing when the OS already reports the value', () => {
    const r = rig({}, { openAtLogin: true })
    r.state.os = true
    r.b.start()
    r.b.settingsChanged()
    expect(r.calls.set).toEqual([])
    // Turned off in the app while the OS already has it off (the user removed it there): no write either.
    r.settings.openAtLogin = false
    r.state.os = false
    r.b.settingsChanged()
    expect(r.calls.set).toEqual([])
  })

  it('applies a change in either direction, once per change', () => {
    const r = rig()
    r.b.start()
    r.settings.openAtLogin = true
    r.b.settingsChanged()
    r.b.settingsChanged() // an unrelated save
    r.settings.openAtLogin = false
    r.b.settingsChanged()
    expect(r.calls.set).toEqual([true, false])
  })

  it('never removes an existing login entry at startup when the setting is off', () => {
    const r = rig()
    r.state.os = true
    r.b.start()
    expect(r.calls.set).toEqual([])
  })

  it('does nothing off Windows and macOS', () => {
    const r = rig({ platform: 'linux' }, { openAtLogin: true })
    r.b.start()
    r.settings.openAtLogin = false
    r.b.settingsChanged()
    expect(r.calls.set).toEqual([])
  })

  it('applies on macOS too', () => {
    const r = rig({ platform: 'darwin' }, { openAtLogin: true })
    r.b.start()
    expect(r.calls.set).toEqual([true])
  })

  it('logs instead of writing in an unpackaged build, once', () => {
    const r = rig({ packaged: false }, { openAtLogin: true })
    r.b.start()
    r.b.settingsChanged()
    expect(r.calls.set).toEqual([])
    expect(r.logs.filter((l) => l.includes('not a packaged build'))).toHaveLength(1)
  })

  it('does not write for a portable build', () => {
    const r = rig({ portable: true }, { openAtLogin: true })
    r.b.start()
    expect(r.calls.set).toEqual([])
    expect(r.logs.join('\n')).toContain('portable')
  })

  it('logs a failed write without throwing and retries on the next save', () => {
    const r = rig({}, { openAtLogin: true })
    r.state.throwOnSet = true
    expect(() => r.b.start()).not.toThrow()
    expect(r.logs.some((l) => l.startsWith('WARN Open at login could not be changed'))).toBe(true)
    r.state.throwOnSet = false
    r.b.settingsChanged()
    expect(r.calls.set).toEqual([true])
  })
})

describe('keepAwakeDuringRuns', () => {
  it('holds one blocker while a run is live and the setting is on, and releases it when the runs end', () => {
    const r = rig({}, { keepAwakeDuringRuns: true })
    r.b.start()
    expect(r.calls.start).toBe(0)
    r.state.live = 2
    r.b.runEvent()
    r.fire()
    expect(r.calls.start).toBe(1)
    expect(r.b.keepingAwake).toBe(true)
    r.state.live = 3
    r.b.runEvent()
    r.fire()
    expect(r.calls.start).toBe(1) // one blocker, not one per run
    r.state.live = 0
    r.b.runEvent()
    r.fire()
    expect(r.calls.stop).toEqual([1])
    expect(r.b.keepingAwake).toBe(false)
  })

  it('starts at once when the setting is turned on during a run, and releases when it is turned off', () => {
    const r = rig()
    r.state.live = 1
    r.b.start()
    expect(r.calls.start).toBe(0)
    r.settings.keepAwakeDuringRuns = true
    r.b.settingsChanged()
    expect(r.calls.start).toBe(1)
    r.settings.keepAwakeDuringRuns = false
    r.b.settingsChanged()
    expect(r.calls.stop).toEqual([1])
  })

  it('holds a blocker already live at startup', () => {
    const r = rig({}, { keepAwakeDuringRuns: true })
    r.state.live = 1
    r.b.start()
    expect(r.calls.start).toBe(1)
  })

  it('ignores run events entirely while the setting is off and nothing is held', () => {
    const r = rig()
    r.state.live = 4
    r.b.runEvent()
    expect(r.timers).toHaveLength(0)
    expect(r.calls.start).toBe(0)
  })

  it('collapses a burst of run events into one re-check', () => {
    const r = rig({}, { keepAwakeDuringRuns: true })
    r.state.live = 1
    for (let i = 0; i < 50; i++) r.b.runEvent()
    expect(r.timers).toHaveLength(1)
  })

  it('starts a new blocker when the OS dropped the old one', () => {
    const r = rig({}, { keepAwakeDuringRuns: true })
    r.state.live = 1
    r.b.start()
    r.state.started.clear()
    r.b.runEvent()
    r.fire()
    expect(r.calls.start).toBe(2)
  })

  it('releases on dispose and ignores later events', () => {
    const r = rig({}, { keepAwakeDuringRuns: true })
    r.state.live = 1
    r.b.start()
    r.b.dispose()
    expect(r.calls.stop).toEqual([1])
    r.b.runEvent()
    r.b.settingsChanged()
    expect(r.calls.start).toBe(1)
  })

  it('survives a blocker that fails to start and a live count that throws', () => {
    const bad = rig({ powerBlocker: { start: () => { throw new Error('no') }, stop: () => {}, isStarted: () => false } }, { keepAwakeDuringRuns: true })
    bad.state.live = 1
    expect(() => bad.b.start()).not.toThrow()
    expect(bad.b.keepingAwake).toBe(false)
    const throwing = rig({ liveRuns: () => { throw new Error('boom') } }, { keepAwakeDuringRuns: true })
    expect(() => throwing.b.start()).not.toThrow()
  })
})

describe('closeActionFor', () => {
  it("keeps today's decisions for 'quit' and when unset", () => {
    for (const action of ['quit', 'stay', 'ask'] as const) {
      expect(closeActionFor(action, 'quit')).toBe(action)
      expect(closeActionFor(action, undefined)).toBe(action)
    }
  })

  it("keepRunning skips the prompt and goes to the background only where it would have asked", () => {
    expect(closeActionFor('ask', 'keepRunning')).toBe('background')
    expect(closeActionFor('quit', 'keepRunning')).toBe('quit') // nothing live: still quits
    expect(closeActionFor('stay', 'keepRunning')).toBe('stay')
  })
})
