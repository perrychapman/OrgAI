import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { name: 'OrgAI', isPackaged: false }, Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() } }))

import { buildMacMenuTemplate } from './appMenu'

const roles = (t: ReturnType<typeof buildMacMenuTemplate>, label: string): string[] => {
  const menu = t.find((m) => m.label === label)
  return ((menu?.submenu ?? []) as { role?: string }[]).map((i) => i.role ?? '-')
}

describe('buildMacMenuTemplate', () => {
  it('has the editing roles that make Cmd+C/V/A work', () => {
    const edit = roles(buildMacMenuTemplate('OrgAI', false), 'Edit')
    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) expect(edit).toContain(r)
  })
  it('offers devtools only in development', () => {
    expect(roles(buildMacMenuTemplate('OrgAI', true), 'View')).toContain('toggleDevTools')
    expect(roles(buildMacMenuTemplate('OrgAI', false), 'View')).not.toContain('toggleDevTools')
  })
  it('has the app, window and quit entries', () => {
    const t = buildMacMenuTemplate('OrgAI', false)
    expect(roles(t, 'OrgAI')).toEqual(expect.arrayContaining(['about', 'hide', 'hideOthers', 'quit']))
    expect(roles(t, 'Window')).toEqual(expect.arrayContaining(['minimize', 'zoom', 'front']))
  })
})
