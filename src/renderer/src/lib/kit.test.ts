import { describe, expect, it } from 'vitest'
import type { KitPreviewItem } from './kitApi'
import {
  actionOptions,
  choicesFromRows,
  defaultChoice,
  defaultChoices,
  emptySelection,
  exportCountLine,
  groupState,
  importedCount,
  kitLastLine,
  mergeChoices,
  needsSecretsLine,
  parseKitLast,
  selectOptions,
  selectionToInclude,
  summarize,
  summaryLine
} from './kit'

function item(over: Partial<KitPreviewItem>): KitPreviewItem {
  return { key: 'k', kind: 'skill', name: 'n', status: 'new', action: 'add', canReplace: true, size: 1, notes: [], ...over }
}

describe('kit actions', () => {
  it('offers Add / Skip for new and nothing for same or refused', () => {
    expect(actionOptions(item({})).map((o) => o.value)).toEqual(['add', 'skip'])
    expect(actionOptions(item({ status: 'same' }))).toEqual([])
    expect(actionOptions(item({ status: 'refused' }))).toEqual([])
  })
  it('offers Replace mine only when it can', () => {
    expect(actionOptions(item({ status: 'different', canReplace: true })).map((o) => o.value)).toContain('replace')
    expect(actionOptions(item({ status: 'different', canReplace: false })).map((o) => o.value)).not.toContain('replace')
  })
  it('dedupes Keep mine and Skip in the select', () => {
    const v = selectOptions(item({ status: 'different' })).map((o) => o.value)
    expect(v).toEqual(['skip', 'replace', 'copy'])
  })
  it('defaults to main action when offered, else the safe one', () => {
    expect(defaultChoice(item({}))).toBe('add')
    expect(defaultChoice(item({ status: 'different', action: 'replace', canReplace: false }))).toBe('skip')
    expect(defaultChoice(item({ status: 'different', action: 'replace' }))).toBe('replace')
    expect(defaultChoice(item({ status: 'same', action: 'add' }))).toBe('skip')
  })
})

describe('kit summary and choices', () => {
  const items = [
    item({ key: 'a' }),
    item({ key: 'b', status: 'different', action: 'skip' }),
    item({ key: 'c', status: 'same' }),
    item({ key: 'd', status: 'refused', refusal: 'x' })
  ]
  it('counts only rows with a choice', () => {
    const s = summarize(items, { ...defaultChoices(items), b: 'copy' })
    expect(s).toEqual({ add: 1, replace: 0, copy: 1, skip: 0, total: 2 })
    expect(summaryLine(s)).toBe('Adds 1, replaces 0, copies 1, skips 0.')
  })
  it('sends every non-refused row, same as skip', () => {
    expect(choicesFromRows(items, defaultChoices(items))).toEqual([
      { key: 'a', action: 'add' },
      { key: 'b', action: 'skip' },
      { key: 'c', action: 'skip' }
    ])
  })
  it('keeps choices for keys that still match', () => {
    const next = mergeChoices({ a: 'skip', b: 'replace', gone: 'add' }, items)
    expect(next).toEqual({ a: 'skip', b: 'replace' })
    expect(mergeChoices({ b: 'add' }, items).b).toBe('skip')
  })
  it('counts imported items', () => {
    expect(importedCount({ added: 2, replaced: 1, copied: 3 })).toBe(6)
  })
})

describe('kit secrets and last line', () => {
  it('lists names with slots', () => {
    expect(needsSecretsLine([])).toBe('')
    expect(needsSecretsLine([{ name: 'gh', env: ['TOKEN'], headers: ['Authorization'], perProject: false }, { name: 'db', env: [], headers: [], perProject: true }])).toBe(
      'These need secret values before agents can use them: gh (TOKEN, Authorization); db, each project enters its own.'
    )
  })
  it('parses and words the last line', () => {
    expect(parseKitLast('nope')).toBeNull()
    expect(parseKitLast(JSON.stringify({ kind: 'x', count: 1, at: 1 }))).toBeNull()
    const last = parseKitLast(JSON.stringify({ kind: 'exported', count: 14, at: Date.UTC(2026, 10, 4, 12) }))
    expect(last).not.toBeNull()
    expect(kitLastLine(last!)).toBe('Exported 14 items on 4 Nov 2026.')
  })
})

describe('kit export selection', () => {
  it('maps to all, ids or absent', () => {
    const sel = emptySelection()
    sel.skills = new Set(['a', 'b'])
    sel.servers = new Set(['s1'])
    const inc = selectionToInclude(sel, { skills: 2, servers: 3, presets: 0, templates: 0 })
    expect(inc).toEqual({ skills: 'all', mcpServers: ['s1'] })
  })
  it('states and count line', () => {
    expect(groupState(0, 3)).toBe('none')
    expect(groupState(1, 3)).toBe('some')
    expect(groupState(3, 3)).toBe('all')
    expect(groupState(0, 0)).toBe('none')
    expect(exportCountLine(0)).toBe('Choose at least one item.')
    expect(exportCountLine(1)).toBe('1 item')
    expect(exportCountLine(14)).toBe('14 items')
  })
})
