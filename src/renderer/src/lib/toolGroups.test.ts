import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG } from '@shared/types'
import { groupState, resolveGroups, summaryParts, summarySentence, toggleGroup } from './toolGroups'

const groups = resolveGroups(TOOL_CATALOG)
const g = (id: string) => groups.find((x) => x.id === id)!

describe('toolGroups', () => {
  it('puts every catalog tool in exactly one group', () => {
    const all = groups.flatMap((x) => x.members)
    expect([...all].sort()).toEqual([...TOOL_CATALOG].sort())
  })

  it('sends an unlisted catalog tool to plan', () => {
    const extra = resolveGroups([...TOOL_CATALOG, 'Mystery'])
    expect(extra.find((x) => x.id === 'plan')!.members).toContain('Mystery')
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

  it('marks elevated phrases', () => {
    expect(summaryParts(groups, ['Read', 'Bash']).map((p) => p.elevated)).toEqual([false, true])
  })
})
