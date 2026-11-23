import { describe, expect, it } from 'vitest'
import {
  buildChoices,
  effectiveSetupChoice,
  elevatedLabels,
  foundLine,
  foundSelectedLine,
  importGroups,
  importSourceSupport,
  levelOptions,
  modeLine,
  importBannerVisible,
  importButtonLabel,
  importCount,
  importedSummary,
  managerSlug,
  notImportedLine,
  otherToolAgents,
  readBannerMemory,
  setupSubmitLabel,
  teamSizeLine,
  toolsDroppedLine,
  totalAgents,
  writeBannerMemory
} from './agentImport'

describe('foundLine', () => {
  it('names agents and instruction files', () => {
    expect(foundLine({ agentSources: [{ source: 'claude', label: 'Claude Code', agentCount: 2 }], instructionFiles: ['AGENTS.md'] })).toBe('Found 2 Claude Code agents and AGENTS.md.')
  })
  it('handles one agent, several sources and many docs', () => {
    expect(
      foundLine({
        agentSources: [
          { source: 'claude', label: 'Claude Code', agentCount: 1 },
          { source: 'opencode', label: 'opencode', agentCount: 3 }
        ]
      })
    ).toBe('Found 1 Claude Code agent and 3 opencode agents.')
    expect(foundLine({ instructionFiles: ['a/AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] })).toBe('Found 3 instruction files.')
  })
  it('says nothing while a team is found, and counts no agents', () => {
    const check = { agentSources: [{ source: 'claude' as const, label: 'Claude Code', agentCount: 2 }], instructionFiles: ['AGENTS.md'], teamFiles: { roleCount: 1, roles: [], skills: [], mcpServers: [], changes: [], problems: [], warnings: [] } }
    expect(foundLine(check)).toBeNull()
    expect(totalAgents(check)).toBe(0)
    expect(otherToolAgents(check)).toBe(2)
    expect(totalAgents({ agentSources: check.agentSources })).toBe(2)
    expect(setupSubmitLabel('team', false)).toBe('Create project')
  })
  it('is null for nothing', () => {
    expect(foundLine({})).toBeNull()
    expect(foundLine(null)).toBeNull()
  })
})

describe('setup choice', () => {
  it('defaults to import when agents exist', () => {
    expect(effectiveSetupChoice(true, null, true)).toBe('import')
    expect(effectiveSetupChoice(true, 'default', true)).toBe('default')
    expect(effectiveSetupChoice(false, 'import', true)).toBe('architect')
    expect(effectiveSetupChoice(false, null, false)).toBe('default')
  })
  it('adds the template choice only with templates', () => {
    expect(effectiveSetupChoice(false, 'template', true, true)).toBe('template')
    expect(effectiveSetupChoice(false, 'template', true, false)).toBe('architect')
    expect(effectiveSetupChoice(true, 'template', true, true)).toBe('template')
    expect(effectiveSetupChoice(false, 'default', true, true)).toBe('default')
    expect(effectiveSetupChoice(false, null, true, true)).toBe('architect')
    expect(effectiveSetupChoice(true, 'template', true, false)).toBe('import')
    expect(setupSubmitLabel('template', false)).toBe('Create from template')
  })
  it('labels the submit button', () => {
    expect(setupSubmitLabel('import', false)).toBe('Create project and review import')
    expect(setupSubmitLabel('architect', false)).toBe('Create and start setup')
    expect(setupSubmitLabel('default', false)).toBe('Create project')
  })
})

describe('choices and counts', () => {
  it('sends only edited fields', () => {
    expect(buildChoices({ a: { include: false }, b: { model: 'sonnet' } })).toEqual([
      { key: 'a', include: false },
      { key: 'b', include: true, model: 'sonnet' }
    ])
  })
  it('counts items that are not skipped', () => {
    expect(importCount({ items: [{ action: 'add' }, { action: 'skip' }, { action: 'replace' }] as never })).toBe(2)
    expect(importButtonLabel(1)).toBe('Add 1 role to the team')
    expect(importButtonLabel(3)).toBe('Add 3 roles to the team')
    expect(importButtonLabel(0)).toBe('Select at least one')
    expect(importButtonLabel(0, 'replace')).toBe('Select at least one')
    expect(importButtonLabel(3, 'replace')).toBe('Replace team with 3 roles')
    expect(modeLine('merge', 3, 4)).toBe('Adds 3 roles next to the 4 you have.')
    expect(modeLine('replace', 3, 1)).toBe('Replaces your 1 role with these 3.')
    expect(elevatedLabels(['Bash', 'Edit', 'Write', 'canSpawn'])).toEqual(['Runs commands', 'Edits files', 'Can start other agents'])
  })
  it('matches a manager by slug, id or name', () => {
    const roles = [{ id: 'r1', slug: 'orchestrator', name: 'Orchestrator' }]
    expect(managerSlug({ reportsTo: 'Orchestrator' }, roles)).toBe('orchestrator')
    expect(managerSlug({ reportsTo: 'r1' }, roles)).toBe('orchestrator')
    expect(managerSlug({ reportsTo: null }, roles)).toBe('')
  })
})

describe('wording and banner memory', () => {
  it('summarises', () => {
    expect(importedSummary(2, ['claude'])).toBe('Imported 2 roles from Claude Code.')
    expect(importedSummary(1, ['claude', 'opencode'])).toBe('Imported 1 role from Claude Code and opencode.')
    expect(notImportedLine(2, [{ label: 'Claude Code' }])).toBe('Found 2 Claude Code agents not in this chart.')
  })
  it('remembers per project', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(importBannerVisible(2, readBannerMemory(storage, 'p1'))).toBe(true)
    writeBannerMemory(storage, 'p1', 'dismissed')
    expect(importBannerVisible(2, readBannerMemory(storage, 'p1'))).toBe(false)
    expect(importBannerVisible(2, readBannerMemory(storage, 'p2'))).toBe(true)
    expect(importBannerVisible(0, null)).toBe(false)
  })
})

describe('import dialog wording and groups', () => {
  it('words the list header, dropped tools and the team size', () => {
    expect(foundSelectedLine(6, 4)).toBe('Found 6 agents. 4 selected.')
    expect(foundSelectedLine(1, 1)).toBe('Found 1 agent. 1 selected.')
    expect(toolsDroppedLine(['Teleport', 'Warp'])).toBe('Its file asks for a tool OrgAI does not have (Teleport, Warp). It will work without it.')
    expect(teamSizeLine(12, 15)).toBe('The team goes from 12 to 15 roles.')
    expect(teamSizeLine(1, 1)).toBe('The team stays at 1 role.')
  })
  it('names levels in plain words and keeps the exact model id', () => {
    const opts = levelOptions({ top: 'big-1', deep: 'big-1', everyday: 'mid-1', fast: 'small-1' }, [{ id: 'mid-1' }, { id: 'extra-9' }])
    expect(opts.map((o) => o.value)).toEqual(['inherit', 'small-1', 'mid-1', 'big-1', 'extra-9'])
    expect(opts.find((o) => o.value === 'small-1')?.label).toBe('Fast · small-1')
    expect(opts.find((o) => o.value === 'mid-1')?.label).toBe('Standard · mid-1')
    expect(opts.find((o) => o.value === 'big-1')?.label).toBe('Advanced · big-1')
    expect(levelOptions({}, undefined).map((o) => o.label)).toEqual(['Inherit from parent', 'Fast', 'Standard', 'Advanced', 'Most capable'])
  })
  it('keeps the unbuilt sources off', () => {
    const s = importSourceSupport()
    expect(s.otherProject).toBe(false)
    expect(s.chooseFolder).toBe(false)
    expect(s.unavailable).toBe('Not available yet')
  })
  it('groups the previewed chart by lead role and marks what is new', () => {
    const role = (id: string, name: string, reportsTo: string | null) => ({ id, name, reportsTo, color: 'c' }) as never
    const roles = [role('o', 'Orchestrator', null), role('l', 'Lead builder', 'o'), role('b', 'Builder', 'l'), role('n', 'Notes', 'o'), role('x', 'Imported', 'l')]
    const items = [{ roleId: 'x', action: 'add' }, { roleId: 'n', action: 'replace' }, { action: 'skip' }] as never
    const groups = importGroups({ roles, items })
    expect(groups.map((g) => g.name)).toEqual(['Orchestrator', 'Lead builder'])
    expect(groups[0].roles).toEqual([
      { id: 'o', name: 'Orchestrator', state: 'existing' },
      { id: 'n', name: 'Notes', state: 'replaces' }
    ])
    expect(groups[1].roles.map((r) => `${r.name}:${r.state}`)).toEqual(['Lead builder:existing', 'Builder:existing', 'Imported:new'])
    expect(groups.map((g) => g.changed)).toEqual([1, 1])
    expect(importGroups({ roles: [], items: [] })).toEqual([])
  })
})
