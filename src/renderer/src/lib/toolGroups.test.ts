import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG } from '@shared/types'
import { TOOL_GROUPS, groupState, resolveGroups, summaryParts, summarySentence, toggleGroup } from './toolGroups'

const groups = resolveGroups(TOOL_CATALOG)
const g = (id: string) => groups.find((x) => x.id === id)!

describe('toolGroups', () => {
  it('puts every catalog tool in exactly one group', () => {
    const all = groups.flatMap((x) => x.members)
    expect([...all].sort()).toEqual([...TOOL_CATALOG].sort())
  })

  it('names every catalog tool in a group, so a new tool forces a grouping decision', () => {
    const named = new Set(TOOL_GROUPS.flatMap((x) => x.tools))
    expect(TOOL_CATALOG.filter((t) => !named.has(t))).toEqual([])
    expect(g('other').members).toEqual([])
  })

  it('sends an unlisted catalog tool and a role tool outside the catalog to the elevated other group', () => {
    const extra = resolveGroups([...TOOL_CATALOG, 'Mystery'], ['Read', 'Rogue'])
    const other = extra.find((x) => x.id === 'other')!
    expect(other.members).toEqual(['Mystery', 'Rogue'])
    expect(other.elevated).toBe(true)
    expect(extra.find((x) => x.id === 'plan')!.members).not.toContain('Mystery')
    expect(summaryParts(extra, ['Read', 'Rogue'])).toEqual([
      { text: 'read files', elevated: false },
      { text: 'use other tools', elevated: true }
    ])
  })

  it('reports on, off and mixed', () => {
    expect(groupState(g('read'), [])).toBe('off')
    expect(groupState(g('read'), ['Read'])).toBe('mixed')
    expect(groupState(g('read'), ['Read', 'Glob', 'Grep'])).toBe('on')
    expect(groupState(g('run'), ['Bash'])).toBe('on')
  })

  it('toggles a group and keeps other tools', () => {
    expect(toggleGroup(g('run'), ['Read'])).toEqual(['Read', 'Bash'])
    expect(toggleGroup(g('run'), ['Read', 'Bash'])).toEqual(['Read'])
    expect(toggleGroup(g('read'), ['Read', 'Bash']).sort()).toEqual(['Bash', 'Glob', 'Grep', 'Read'])
    expect(toggleGroup(g('read'), ['Read', 'Glob', 'Grep'])).toEqual([])
  })

  it('writes the summary sentence', () => {
    expect(summarySentence(groups, [])).toBe('No tools. It can only answer from what it is told.')
    expect(summarySentence(groups, ['Read', 'Glob', 'Grep'])).toBe('Can read files.')
    expect(summarySentence(groups, ['Read', 'WebFetch'])).toBe('Can read files and browse the web.')
    expect(summarySentence(groups, ['Read', 'Edit', 'Bash'])).toBe('Can read files, change files and run commands.')
  })

  it('never writes two spaces in a row, whatever groups are on (QA P1)', () => {
    const reps = ['Read', 'Edit', 'Bash', 'WebFetch', 'TodoWrite', 'Rogue']
    for (let mask = 0; mask < 1 << reps.length; mask++) {
      const tools = reps.filter((_, i) => mask & (1 << i))
      const text = summarySentence(resolveGroups(TOOL_CATALOG, tools), tools)
      expect(text).not.toMatch(/\s{2}/)
      expect(text).toBe(text.trim())
    }
  })

  it('marks elevated phrases', () => {
    expect(summaryParts(groups, ['Read', 'Bash']).map((p) => p.elevated)).toEqual([false, true])
  })
})
