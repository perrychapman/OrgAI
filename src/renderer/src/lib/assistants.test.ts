import { describe, expect, it } from 'vitest'
import type { QuickRunInfo } from '@shared/types'
import { ASSISTANT_ORDER, canPromote, chatSummaryLine, displayProject, locationLabel, newSessionLabel, promoteName, quickAccessLabel, quickFolderLabel, runKindLabel } from './assistants'

const quick = (over: Partial<QuickRunInfo> = {}): QuickRunInfo => ({ folder: 'C:\\work\\notes-api', team: 'single', allowEdits: false, gitRepo: false, ...over })

describe('assistants', () => {
  it('orders the rows', () => expect(ASSISTANT_ORDER).toEqual(['quick', 'harness', 'skills']))
  it('names locations', () => {
    const projects = [{ id: 'p1', name: 'Shop' }]
    expect(locationLabel('quick', projects)).toBe('Chat')
    expect(locationLabel('harness', projects)).toBe('MCP assistant')
    expect(locationLabel('p1', projects)).toBe('Shop')
    expect(locationLabel('gone', projects)).toBe('Project')
  })
  it('builds a display project', () => {
    expect(displayProject('skills')).toMatchObject({ id: 'skills', name: 'Skill assistant', path: '', roles: [] })
  })
  it('labels kinds', () => {
    expect(runKindLabel({ kind: 'work', quick: quick() })).toBe('Chat')
    expect(runKindLabel({ kind: 'work' })).toBe('Run')
    expect(runKindLabel({ kind: 'skill-assist' })).toBe('Skill assistant')
  })
  it('labels folder and access', () => {
    expect(quickFolderLabel(quick())).toBe('notes-api')
    expect(quickFolderLabel(quick({ scratch: true }))).toBe('Scratch')
    expect(quickAccessLabel(quick({ allowEdits: true }))).toBe('edits allowed')
    expect(quickAccessLabel(quick())).toBe('read-only')
  })
  it('proposes a project name', () => {
    expect(promoteName({ quick: quick(), title: 'x' })).toBe('notes-api')
    expect(promoteName({ quick: quick({ scratch: true }), title: '  Fix  the build ' })).toBe('Fix the build')
    expect(promoteName({ quick: quick({ scratch: true }) })).toBe('Chat')
    expect(promoteName({ quick: quick({ scratch: true }), title: 'a'.repeat(200) })).toHaveLength(80)
  })
  it('refuses to promote scratch', () => {
    expect(canPromote({ quick: quick() })).toEqual({ ok: true })
    expect(canPromote({ quick: quick({ scratch: true }) }).reason).toBe('A scratch chat cannot become a project')
  })
  it('summarises a chat', () => {
    expect(chatSummaryLine({ scratch: true, allowEdits: false, model: 'Everyday tier', connection: 'Anthropic' })).toBe(
      'Works in a private scratch area. Reads files, asks before editing. Runs on Everyday tier via Anthropic. Change in App settings > Defaults. Counts toward your usage.'
    )
    const line = chatSummaryLine({ scratch: false, folderName: 'api', allowEdits: true, model: '', mock: true })
    expect(line).toContain('Works in api. Reads and edits files')
    expect(line).toContain('Mock run, no tokens.')
  })
  it('names the new-session button', () => {
    expect(newSessionLabel('quick')).toBe('New chat')
    expect(newSessionLabel('skills')).toBe('New session')
  })
})
