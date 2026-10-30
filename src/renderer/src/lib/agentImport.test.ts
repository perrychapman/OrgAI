import { describe, expect, it } from 'vitest'
import {
  buildChoices,
  effectiveSetupChoice,
  elevatedLabels,
  foundLine,
  modeLine,
  importBannerVisible,
  importButtonLabel,
  importCount,
  importedSummary,
  managerSlug,
  notImportedLine,
  readBannerMemory,
  setupSubmitLabel,
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
    expect(importButtonLabel(1)).toBe('Import 1 role')
    expect(importButtonLabel(3)).toBe('Import 3 roles')
    expect(importButtonLabel(3, 'replace')).toBe('Replace chart with 3 roles')
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
