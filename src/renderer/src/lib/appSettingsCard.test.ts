import { describe, expect, it } from 'vitest'
import type { AppSettingChange, Project } from '@shared/types'
import { formatAppSettingValue, groupAppSettingChanges, projectSettingRows, surfaceForField, swatchOf } from './appSettingsCard'

const ch = (field: AppSettingChange['field'], from: AppSettingChange['from'], to: AppSettingChange['to']): AppSettingChange => ({ field, from, to, label: field })

describe('formatAppSettingValue', () => {
  it('words booleans, caps and enums', () => {
    expect(formatAppSettingValue('notifications', true)).toBe('On')
    expect(formatAppSettingValue('defaultIsolateWriters', false)).toBe('Off')
    expect(formatAppSettingValue('defaultMaxBudgetUsd', null)).toBe('No cap')
    expect(formatAppSettingValue('defaultMaxBudgetUsd', 5)).toBe('$5')
    expect(formatAppSettingValue('quickRunModel', null)).toBe('Not set')
    expect(formatAppSettingValue('appearance.theme', 'system')).toBe('Match system')
    expect(formatAppSettingValue('appearance.reduceMotion', 'on')).toBe('On')
    expect(formatAppSettingValue('appearance.canvas.pattern', 'blueprint')).toBe('Blueprint')
    expect(formatAppSettingValue('appearance.canvas.layout', 'left-right')).toBe('Left to right')
    expect(formatAppSettingValue('appearance.canvas.edges', 'orthogonal')).toBe('Right angle')
    expect(formatAppSettingValue('appearance.canvas.nodeStyle', 'hex')).toBe('Honeycomb')
    expect(formatAppSettingValue('defaultPermissionMode', 'default')).toBe('Ask for everything risky')
    expect(formatAppSettingValue('setupModel', 'deep')).toBe('Deep tier')
    expect(formatAppSettingValue('defaultReportModel', 'claude-x')).toBe('claude-x')
    expect(formatAppSettingValue('defaultKeepRuns', 40)).toBe('40')
    expect(formatAppSettingValue('appearance.accent', '#336699')).toBe('#336699')
  })
  it('shows hidden characters in string values', () => {
    expect(formatAppSettingValue('defaultRootModel', 'a‮b')).not.toContain('‮')
  })
  it('finds a swatch only for a hex accent', () => {
    expect(swatchOf('appearance.accent', '#abc')).toBe('#abc')
    expect(swatchOf('appearance.accent', 'red')).toBeNull()
    expect(swatchOf('appearance.theme', '#abc')).toBeNull()
  })
})

describe('grouping', () => {
  it('maps canvas and motion out of Appearance', () => {
    expect(surfaceForField('appearance.canvas.pattern')).toBe('app-settings-general-canvas')
    expect(surfaceForField('appearance.reduceMotion')).toBe('app-settings-general-motion')
    expect(surfaceForField('appearance.theme')).toBe('app-settings-general-appearance')
  })
  it('groups rows by pane in first-seen order, with a plain group for fields no screen shows', () => {
    const groups = groupAppSettingChanges([ch('appearance.theme', 'dark', 'light'), ch('appearance.canvas.pattern', 'dots', 'grid'), ch('appearance.accent', '#111111', '#222222'), ch('defaultKeepRuns', 10, 20)])
    expect(groups.map((g) => g.path)).toEqual([
      'App settings › General › Appearance',
      'App settings › General › Canvas',
      'App settings › General › New projects (not shown on a screen yet)'
    ])
    expect(groups[0].changes).toHaveLength(2)
  })
})

describe('projectSettingRows', () => {
  const project = { permissionMode: 'default', maxBudgetUsd: 2, isolateWriters: true } as unknown as Project
  it('pairs the payload with the stored project', () => {
    const rows = projectSettingRows({ rationale: '', permissionMode: 'acceptEdits', maxBudgetUsd: null, maxSubagentDepth: 2, isolateWriters: false }, 'code', project)
    expect(rows.map((r) => [r.field, r.now, r.next])).toEqual([
      ['permissionMode', 'Ask for everything risky', 'Auto-accept file edits, ask for commands'],
      ['maxBudgetUsd', '$2', 'No cap'],
      ['maxSubagentDepth', 'Automatic', '2'],
      ['isolateWriters', 'On', 'Off']
    ])
  })
  it('says Unknown when the project is not loaded and words engagements', () => {
    const rows = projectSettingRows({ rationale: '', isolateWriters: true, client: ' ' }, 'engagement', undefined)
    expect(rows.map((r) => [r.label, r.now, r.next])).toEqual([
      ['Client or case', 'Unknown', 'Cleared'],
      ['Give each writer its own copy (git worktrees)', 'Unknown', 'On']
    ])
  })
  it('never hides a client change, even when the kind is guessed as code (review M2)', () => {
    const rows = projectSettingRows({ rationale: '', client: 'Acme' }, 'code', undefined)
    expect(rows.map((r) => r.field)).toEqual(['client'])
  })
})
