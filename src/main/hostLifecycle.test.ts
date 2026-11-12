import { describe, expect, it } from 'vitest'
import {
  CLOSE_PROMPT_BUTTONS,
  CLOSE_PROMPT_CANCEL_ID,
  closePromptChoice,
  closePromptText,
  reopenAfterCancel,
  windowAllClosedAction
} from './hostLifecycle'

describe('windowAllClosedAction (review H3)', () => {
  const expected = (platform: string, quitting: boolean, workingRuns: number): string => {
    if (quitting) return 'quit'
    if (platform === 'darwin') return 'stay'
    return workingRuns > 0 ? 'ask' : 'quit'
  }
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const quitting of [false, true]) {
      for (const workingRuns of [0, 2]) {
        it(`${platform} quitting=${quitting} working=${workingRuns}`, () => {
          expect(windowAllClosedAction({ platform, quitting, workingRuns })).toBe(expected(platform, quitting, workingRuns))
        })
      }
    }
  }
  it('off macOS it quits unless runs are working, and then asks; it never goes to the background by itself', () => {
    for (const platform of ['win32', 'linux']) {
      expect(windowAllClosedAction({ platform, quitting: false, workingRuns: 0 })).toBe('quit')
      expect(windowAllClosedAction({ platform, quitting: false, workingRuns: 1 })).toBe('ask')
    }
  })
  it('macOS keeps the app (Dock) whatever its runs do', () => {
    expect(windowAllClosedAction({ platform: 'darwin', quitting: false, workingRuns: 0 })).toBe('stay')
    expect(windowAllClosedAction({ platform: 'darwin', quitting: false, workingRuns: 3 })).toBe('stay')
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
