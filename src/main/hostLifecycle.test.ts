import { describe, expect, it } from 'vitest'
import { parseHostArgs, quitPromptButtons, quitPromptNeeded, secondInstanceAction, windowAllClosedAction } from './hostLifecycle'

describe('parseHostArgs', () => {
  it('reads nothing from a plain launch', () => {
    expect(parseHostArgs(['/x/Electron', '/app'])).toEqual({ headless: false })
  })
  it('reads --headless-host anywhere', () => {
    expect(parseHostArgs(['/x/Electron', '--headless-host', '/app'])).toEqual({ headless: true })
    expect(parseHostArgs(['/x/Electron', '/app', '--headless-host'])).toEqual({ headless: true })
  })
  it('reads --run <id> and --run=<id>', () => {
    expect(parseHostArgs(['e', '/app', '--run', 'run_abc-1'])).toEqual({ headless: false, run: 'run_abc-1' })
    expect(parseHostArgs(['e', '/app', '--run=R2'])).toEqual({ headless: false, run: 'R2' })
    expect(parseHostArgs(['e', '--headless-host', '--run=R2'])).toEqual({ headless: true, run: 'R2' })
  })
  it('drops bad run ids', () => {
    expect(parseHostArgs(['e', '--run', '../etc'])).toEqual({ headless: false })
    expect(parseHostArgs(['e', '--run=a b'])).toEqual({ headless: false })
    expect(parseHostArgs(['e', '--run='])).toEqual({ headless: false })
    expect(parseHostArgs(['e', `--run=${'a'.repeat(129)}`])).toEqual({ headless: false })
    expect(parseHostArgs(['e', `--run=${'a'.repeat(128)}`]).run).toBe('a'.repeat(128))
    expect(parseHostArgs(['e', '--run'])).toEqual({ headless: false })
  })
  it('does not swallow a following flag as the run id', () => {
    expect(parseHostArgs(['e', '--run', '--headless-host'])).toEqual({ headless: true })
  })
  it('ignores look-alike flags', () => {
    expect(parseHostArgs(['e', '--headless-hosts', '--running=x', '--headless'])).toEqual({ headless: false })
  })
})

describe('secondInstanceAction', () => {
  const base = { argv: ['e', '/app'], additionalData: undefined, booted: true, quitting: false }
  it('opens a window for a plain launch', () => {
    expect(secondInstanceAction(base)).toEqual({ kind: 'window' })
  })
  it('passes the run id', () => {
    expect(secondInstanceAction({ ...base, argv: ['e', '--run', 'r1'] })).toEqual({ kind: 'window', run: 'r1' })
    expect(secondInstanceAction({ ...base, additionalData: { headless: false, run: 'r2' } })).toEqual({ kind: 'window', run: 'r2' })
  })
  it('a headless launch never gives a window', () => {
    expect(secondInstanceAction({ ...base, argv: ['e', '--headless-host'] })).toEqual({ kind: 'headless' })
    expect(secondInstanceAction({ ...base, argv: ['e', '--headless-host', '--run', 'r1'] })).toEqual({ kind: 'headless' })
    expect(secondInstanceAction({ ...base, additionalData: { headless: true, run: 'r1' } })).toEqual({ kind: 'headless' })
  })
  it('additionalData beats argv', () => {
    expect(secondInstanceAction({ ...base, argv: ['e', '--headless-host'], additionalData: { headless: false } })).toEqual({ kind: 'window' })
    expect(secondInstanceAction({ ...base, argv: ['e', '/app'], additionalData: { headless: true } })).toEqual({ kind: 'headless' })
    expect(secondInstanceAction({ ...base, argv: ['e', '--run', 'argvrun'], additionalData: { headless: false, run: 'datarun' } })).toEqual({ kind: 'window', run: 'datarun' })
  })
  it('drops a bad run id from additionalData', () => {
    expect(secondInstanceAction({ ...base, additionalData: { headless: false, run: '../x' } })).toEqual({ kind: 'window' })
  })
  it('falls back to argv when additionalData is malformed', () => {
    for (const additionalData of [null, 'x', 3, [], {}, { headless: 'yes' }]) {
      expect(secondInstanceAction({ ...base, argv: ['e', '--headless-host'], additionalData })).toEqual({ kind: 'headless' })
    }
  })
  it('ignores launches before boot or while quitting', () => {
    expect(secondInstanceAction({ ...base, booted: false })).toEqual({ kind: 'ignore' })
    expect(secondInstanceAction({ ...base, quitting: true })).toEqual({ kind: 'ignore' })
    expect(secondInstanceAction({ ...base, booted: false, additionalData: { headless: true } })).toEqual({ kind: 'ignore' })
  })
})

describe('windowAllClosedAction', () => {
  const expected = (platform: string, busy: boolean, startedHeadless: boolean, quitting: boolean): string => {
    if (quitting) return 'quit'
    if (busy) return 'background'
    if (startedHeadless || platform !== 'darwin') return 'quit'
    return 'stay'
  }
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const busy of [false, true]) {
      for (const startedHeadless of [false, true]) {
        for (const quitting of [false, true]) {
          it(`${platform} busy=${busy} headless=${startedHeadless} quitting=${quitting}`, () => {
            expect(windowAllClosedAction({ platform, busy, startedHeadless, quitting })).toBe(expected(platform, busy, startedHeadless, quitting))
          })
        }
      }
    }
  }
  it('spot checks', () => {
    expect(windowAllClosedAction({ platform: 'darwin', busy: false, startedHeadless: false, quitting: false })).toBe('stay')
    expect(windowAllClosedAction({ platform: 'win32', busy: false, startedHeadless: false, quitting: false })).toBe('quit')
    expect(windowAllClosedAction({ platform: 'linux', busy: true, startedHeadless: false, quitting: false })).toBe('background')
    expect(windowAllClosedAction({ platform: 'darwin', busy: true, startedHeadless: true, quitting: true })).toBe('quit')
  })
})

describe('quitPromptNeeded', () => {
  it('asks only with clients, not from a drain, not answered', () => {
    for (const terminalClients of [0, 1, 3]) {
      for (const drainQuit of [false, true]) {
        for (const alreadyAnswered of [false, true]) {
          expect(quitPromptNeeded({ terminalClients, drainQuit, alreadyAnswered })).toBe(terminalClients > 0 && !drainQuit && !alreadyAnswered)
        }
      }
    }
  })
  it('names the client count', () => {
    expect(quitPromptButtons(1)[0]).toBe('Keep background host running for 1 terminal client')
    expect(quitPromptButtons(2)).toEqual(['Keep background host running for 2 terminal clients', 'Stop all runs and quit', 'Cancel'])
  })
})
