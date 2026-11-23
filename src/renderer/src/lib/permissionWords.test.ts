import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { PERMISSION_MODE_OPTIONS } from '@shared/types'
import { PERMISSION_TITLE, RECOMMENDED_PERMISSION_MODE, permissionTitle, permissionWords } from './permissionWords'

describe('permissionWords', () => {
  it('names every mode once, with a distinct plain title', () => {
    const modes = PERMISSION_MODE_OPTIONS.map((o) => o.value)
    expect(Object.keys(PERMISSION_TITLE).sort()).toEqual([...modes].sort())
    expect(new Set(Object.values(PERMISSION_TITLE)).size).toBe(modes.length)
  })
  it('keeps the exact mode name and the shared description as secondary text', () => {
    expect(permissionWords('auto')).toMatchObject({ title: 'Go ahead within the rules', engine: 'Unattended' })
    expect(permissionWords('default')).toMatchObject({ title: 'Ask before risky actions', engine: 'Ask for everything risky' })
    expect(permissionWords('bypassPermissions').title).toBe('Skip all checks')
    expect(permissionWords('plan').description).toMatch(/nothing is changed/)
  })
  it('never uses the old overlapping names as a title', () => {
    for (const t of Object.values(PERMISSION_TITLE)) expect(t).not.toMatch(/Unattended|Work on its own|Ask about everything|Bypass all|Ask before every change/)
    expect(permissionTitle('acceptEdits')).toBe('Edit freely, ask for commands')
  })
  it('marks Recommended only the mode the app uses by default for a new project', () => {
    expect(RECOMMENDED_PERMISSION_MODE).toBe(DEFAULT_APP_SETTINGS.defaultPermissionMode)
  })
})
