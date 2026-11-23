import { describe, expect, it } from 'vitest'
import { APP_SETTINGS_PANES } from '../../lib/settingsTarget'
import { openToolsAndServices } from './openToolsAndServices'

describe('openToolsAndServices', () => {
  it('asks for the connectors pane, switches to app Settings, then announces, in that order', () => {
    const calls: string[] = []
    openToolsAndServices({
      requestSection: (pane) => calls.push(`request:${pane}`),
      setView: (view) => calls.push(`view:${view}`),
      announce: () => calls.push('announce')
    })
    expect(calls).toEqual([`request:${APP_SETTINGS_PANES.mcpLibrary}`, 'view:appSettings', 'announce'])
  })
})
