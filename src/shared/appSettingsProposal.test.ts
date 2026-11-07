import { describe, expect, it } from 'vitest'
import { APP_SETTINGS_PROPOSABLE_FIELDS } from './types'
import { DEFAULT_APP_SETTINGS } from './defaults'
import { APP_SETTING_FIELD_LABELS, appSettingEnumValues, appSettingValue, appSettingValueProblem, withAppSettingChanges } from './appSettingsProposal'

describe('appSettingValueProblem', () => {
  it('labels every proposable field', () => {
    for (const f of APP_SETTINGS_PROPOSABLE_FIELDS) expect(APP_SETTING_FIELD_LABELS[f]).toBeTruthy()
  })
  it('refuses unknown and main-owned fields', () => {
    for (const f of ['defaultConnection', 'proxies', 'terminalServer', 'modelPrices', 'connections', '__proto__', 42]) {
      expect(appSettingValueProblem(f, 'x')).toMatch(/not a setting/)
    }
  })
  it('checks enums, booleans, accent, models and numbers', () => {
    expect(appSettingValueProblem('appearance.theme', 'light')).toBeNull()
    expect(appSettingValueProblem('appearance.theme', 'neon')).toMatch(/one of/)
    expect(appSettingValueProblem('notifications', 'yes')).toMatch(/true or false/)
    expect(appSettingValueProblem('appearance.accent', '#7c5cff')).toBeNull()
    expect(appSettingValueProblem('appearance.accent', '#7C5CFF')).not.toBeNull()
    expect(appSettingValueProblem('setupModel', 'deep')).toBeNull()
    expect(appSettingValueProblem('setupModel', 'inherit')).not.toBeNull()
    expect(appSettingValueProblem('setupModel', 'has space')).not.toBeNull()
    expect(appSettingValueProblem('opusGuardThreshold', 80)).toBeNull()
    expect(appSettingValueProblem('opusGuardThreshold', 101)).not.toBeNull()
    expect(appSettingValueProblem('defaultKeepRuns', 1.5)).not.toBeNull()
    expect(appSettingValueProblem('defaultMaxBudgetUsd', null)).toBeNull()
    expect(appSettingValueProblem('defaultMaxBudgetUsd', 0)).not.toBeNull()
    expect(appSettingValueProblem('defaultMaxBudgetUsd', Number.NaN)).not.toBeNull()
    expect(appSettingValueProblem('defaultKeepRuns', null)).not.toBeNull()
  })
  it('never lets a proposal set bypassPermissions', () => {
    expect(appSettingValueProblem('defaultPermissionMode', 'bypassPermissions')).not.toBeNull()
    expect(appSettingEnumValues('defaultPermissionMode')).not.toContain('bypassPermissions')
    expect(appSettingValueProblem('defaultPermissionMode', 'default')).toBeNull()
  })
})

describe('appSettingValue / withAppSettingChanges', () => {
  it('reads nested values and applies changes to a copy', () => {
    const s = DEFAULT_APP_SETTINGS
    expect(appSettingValue(s, 'appearance.theme')).toBe(s.appearance.theme)
    const next = withAppSettingChanges(s, [
      { field: 'appearance.theme', to: 'light' },
      { field: 'appearance.canvas.minimap', to: !s.appearance.canvas.minimap }
    ])
    expect(next.appearance.theme).toBe('light')
    expect(next.appearance.canvas.minimap).toBe(!s.appearance.canvas.minimap)
    expect(s.appearance.theme).not.toBe('light')
  })
  it('clears an optional field with an own undefined (settings:set semantics)', () => {
    const next = withAppSettingChanges({ ...DEFAULT_APP_SETTINGS, defaultMaxBudgetUsd: 3 }, [{ field: 'defaultMaxBudgetUsd', to: null }])
    expect(Object.hasOwn(next, 'defaultMaxBudgetUsd')).toBe(true)
    expect(next.defaultMaxBudgetUsd).toBeUndefined()
  })
  it('throws and changes nothing when any value is refused', () => {
    expect(() => withAppSettingChanges(DEFAULT_APP_SETTINGS, [{ field: 'appearance.theme', to: 'light' }, { field: 'notifications', to: 'x' }])).toThrow()
  })
})
