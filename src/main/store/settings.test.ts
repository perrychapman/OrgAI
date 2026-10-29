import { describe, expect, it } from 'vitest'
import { normalizeSettings } from './settings'

describe('normalizeSettings', () => {
  it('defaults to the unattended permission mode', () => {
    expect(normalizeSettings(null).defaultPermissionMode).toBe('auto')
  })

  it('keeps every known mode and drops unknown ones', () => {
    for (const mode of ['auto', 'acceptEdits', 'default', 'dontAsk', 'plan', 'bypassPermissions'] as const) {
      expect(normalizeSettings({ defaultPermissionMode: mode }).defaultPermissionMode).toBe(mode)
    }
    expect(normalizeSettings({ defaultPermissionMode: 'yolo' as never }).defaultPermissionMode).toBe('auto')
  })
})
