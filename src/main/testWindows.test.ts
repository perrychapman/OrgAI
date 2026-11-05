import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] } }))

const { hiddenWindowsFor } = await import('./testWindows')

describe('hiddenWindowsFor', () => {
  it('hides windows only for ORGAI_E2E_HIDDEN=1 in an unpackaged build', () => {
    expect(hiddenWindowsFor({ ORGAI_E2E_HIDDEN: '1' }, false)).toBe(true)
    expect(hiddenWindowsFor({ ORGAI_E2E_HIDDEN: '1' }, true)).toBe(false)
    expect(hiddenWindowsFor({ ORGAI_E2E_HIDDEN: 'true' }, false)).toBe(false)
    expect(hiddenWindowsFor({}, false)).toBe(false)
  })
})
