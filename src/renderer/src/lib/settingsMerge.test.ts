import { describe, expect, it } from 'vitest'
import type { AppSettings, AppSettingsInfo } from '@shared/types'
import { mergePendingSettings } from './settingsMerge'

describe('mergePendingSettings', () => {
  it('keeps the edited fields and takes everything else from the incoming settings', () => {
    const pending = { setupModel: 'fast', communityPrices: false, notifications: true } as unknown as AppSettings
    const incoming = { setupModel: 'deep', communityPrices: true, notifications: false, dataDir: '/d', appVersion: '1' } as unknown as AppSettingsInfo
    const out = mergePendingSettings(pending, incoming, new Set<keyof AppSettings>(['setupModel']))
    expect(out).toEqual({ setupModel: 'fast', communityPrices: true, notifications: false })
    expect('dataDir' in out).toBe(false)
  })
  it('an edited field that was cleared stays cleared', () => {
    const pending = { setupModel: undefined } as unknown as AppSettings
    const incoming = { setupModel: 'deep', dataDir: '/d', appVersion: '1' } as unknown as AppSettingsInfo
    expect(mergePendingSettings(pending, incoming, new Set<keyof AppSettings>(['setupModel'])).setupModel).toBeUndefined()
  })
})
