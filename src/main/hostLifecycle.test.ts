import { describe, expect, it } from 'vitest'
import {
  CLOSE_PROMPT_BUTTONS,
  CLOSE_PROMPT_CANCEL_ID,
  closePromptChoice,
  closePromptText,
  parseHostArgs,
  quitPromptButtons,
  quitPromptNeeded,
  reopenAfterCancel,
  secondInstanceAction,
  windowAllClosedAction
} from './hostLifecycle'

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

describe('windowAllClosedAction (review H3)', () => {
  const expected = (platform: string, launchedHeadless: boolean, quitting: boolean, workingRuns: number): string => {
    if (quitting) return 'quit'
    if (launchedHeadless && workingRuns === 0) return 'background'
    if (platform === 'darwin') return 'stay'
    return workingRuns > 0 ? 'ask' : 'quit'
  }
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const launchedHeadless of [false, true]) {
      for (const quitting of [false, true]) {
        for (const workingRuns of [0, 2]) {
          it(`${platform} headless=${launchedHeadless} quitting=${quitting} working=${workingRuns}`, () => {
            expect(windowAllClosedAction({ platform, launchedHeadless, quitting, workingRuns })).toBe(expected(platform, launchedHeadless, quitting, workingRuns))
          })
        }
      }
    }
  }
  it('a desktop launch off macOS quits unless runs are working, and then asks; it never goes to the background by itself', () => {
    for (const platform of ['win32', 'linux']) {
      expect(windowAllClosedAction({ platform, launchedHeadless: false, quitting: false, workingRuns: 0 })).toBe('quit')
      expect(windowAllClosedAction({ platform, launchedHeadless: false, quitting: false, workingRuns: 1 })).toBe('ask')
    }
  })
  it('macOS keeps the app (Dock) whatever its runs do', () => {
    expect(windowAllClosedAction({ platform: 'darwin', launchedHeadless: false, quitting: false, workingRuns: 0 })).toBe('stay')
    expect(windowAllClosedAction({ platform: 'darwin', launchedHeadless: false, quitting: false, workingRuns: 3 })).toBe('stay')
  })
  it('a --headless-host launch goes back to the background while no run is working (daemon mode, idle exit decides)', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(windowAllClosedAction({ platform, launchedHeadless: true, quitting: false, workingRuns: 0 })).toBe('background')
      expect(windowAllClosedAction({ platform, launchedHeadless: true, quitting: true, workingRuns: 1 })).toBe('quit')
    }
  })
  it('a --headless-host launch with working runs never sends them to the background unasked (review follow-up)', () => {
    // `orgai status` spawned the host, the user opened OrgAI from the Start menu (a window in that host), started a
    // run and closed the window.
    for (const platform of ['win32', 'linux']) {
      expect(windowAllClosedAction({ platform, launchedHeadless: true, quitting: false, workingRuns: 1 })).toBe('ask')
      expect(windowAllClosedAction({ platform, launchedHeadless: true, quitting: false, workingRuns: 4 })).toBe('ask')
    }
    expect(windowAllClosedAction({ platform: 'darwin', launchedHeadless: true, quitting: false, workingRuns: 2 })).toBe('stay')
  })
})

describe('close prompt', () => {
  it('maps responses; anything unexpected cancels', () => {
    expect(CLOSE_PROMPT_BUTTONS).toEqual(['Keep working in the background', 'Stop and quit', 'Cancel'])
    expect(closePromptChoice(0)).toBe('background')
    expect(closePromptChoice(1)).toBe('quit')
    expect(closePromptChoice(CLOSE_PROMPT_CANCEL_ID)).toBe('cancel')
    expect(closePromptChoice(-1)).toBe('cancel')
    expect(closePromptChoice(7)).toBe('cancel')
  })
  it('names the working runs', () => {
    expect(closePromptText(1).message).toBe('A run is still working.')
    expect(closePromptText(3).message).toBe('3 runs are still working.')
    expect(closePromptText(Number.NaN).message).toBe('A run is still working.')
    expect(closePromptText(2).detail).toMatch(/background/)
  })
  it('a cancelled quit with no window reopens one off macOS', () => {
    expect(reopenAfterCancel({ platform: 'win32', liveWindows: 0, quitting: false })).toBe(true)
    expect(reopenAfterCancel({ platform: 'linux', liveWindows: 0, quitting: false })).toBe(true)
    expect(reopenAfterCancel({ platform: 'linux', liveWindows: 1, quitting: false })).toBe(false)
    expect(reopenAfterCancel({ platform: 'darwin', liveWindows: 0, quitting: false })).toBe(false)
    expect(reopenAfterCancel({ platform: 'win32', liveWindows: 0, quitting: true })).toBe(false)
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
