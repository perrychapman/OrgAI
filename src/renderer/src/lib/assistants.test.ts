import { describe, expect, it } from 'vitest'
import type { QuickRunInfo } from '@shared/types'
import { ASSISTANT_ORDER, offersRetro, promoteNameError, canPromote, chatSummaryLine, displayProject, locationLabel, newSessionLabel, promoteName, quickAccessLabel, quickFolderLabel, runKindLabel } from './assistants'
import { assistantModeLabel, composerPlaceholder, isSingleAgentRun, offersSaveAsProject, runLayoutFor, speaksAsAssistant } from './assistants'

describe('run layout', () => {
  it('single-agent runs default to the conversation', () => {
    expect(isSingleAgentRun({ kind: 'work', quick: quick() })).toBe(true)
    expect(isSingleAgentRun({ kind: 'mcp-assist' })).toBe(true)
    expect(isSingleAgentRun({ kind: 'skill-assist' })).toBe(true)
    expect(runLayoutFor({ kind: 'work', quick: quick() })).toBe('conversation')
  })
  it('team runs default to the canvas', () => {
    expect(runLayoutFor({ kind: 'work', quick: quick({ team: 'default' }) })).toBe('canvas')
    expect(runLayoutFor({ kind: 'work' })).toBe('canvas')
    expect(runLayoutFor({ kind: 'setup' })).toBe('canvas')
  })
  it('the user choice wins', () => {
    expect(runLayoutFor({ kind: 'mcp-assist' }, 'canvas')).toBe('canvas')
    expect(runLayoutFor({ kind: 'work' }, 'conversation')).toBe('conversation')
  })
})

describe('offersSaveAsProject', () => {
  it('only while the run is in the Chat project', () => {
    expect(offersSaveAsProject({ quick: quick(), projectId: 'quick' })).toBe(true)
    expect(offersSaveAsProject({ quick: quick(), projectId: 'p-123' })).toBe(false)
    expect(offersSaveAsProject({ projectId: 'quick' })).toBe(false)
  })
})

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
  it('offers the retrospective only for finished real-project work runs', () => {
    const base = { kind: 'work' as const, projectId: 'p1', status: 'finished' as const }
    expect(offersRetro(base)).toBe(true)
    expect(offersRetro({ ...base, quick: quick() })).toBe(false)
    expect(offersRetro({ ...base, projectId: 'quick' })).toBe(false)
    expect(offersRetro({ ...base, kind: 'setup' })).toBe(false)
    expect(offersRetro({ ...base, status: 'running' })).toBe(false)
  })
  it('validates the promote name', () => {
    expect(promoteNameError('  ')).toBeTruthy()
    expect(promoteNameError('api')).toBeNull()
    expect(promoteNameError('x'.repeat(81))).toBeTruthy()
  })
})

describe('assistantModeLabel', () => {
  it('points at the card while one is open, whatever the status', () => {
    expect(assistantModeLabel({ status: 'idle', openCards: 1 })).toBe('Waiting for your answer')
    expect(assistantModeLabel({ status: 'running', openCards: 2 })).toBe('Waiting for your answer')
  })
  it('says it is the user turn when idle with nothing open, never "Done."', () => {
    expect(assistantModeLabel({ status: 'idle', openCards: 0 })).toBe('Your turn. Reply, ask a follow-up, or end the session.')
  })
  it('reads Reply to the assistant while running', () => {
    expect(assistantModeLabel({ status: 'running', openCards: 0 })).toBe('Reply to the assistant')
  })
})

describe('speaksAsAssistant', () => {
  it('covers virtual projects and skill-assist runs on a real project', () => {
    expect(speaksAsAssistant({ kind: 'work', quick: undefined, projectId: 'quick' })).toBe(true)
    expect(speaksAsAssistant({ kind: 'skill-assist', quick: undefined, projectId: 'p1' })).toBe(true)
    expect(speaksAsAssistant({ kind: 'work', quick: undefined, projectId: 'p1' })).toBe(false)
  })
})

describe('composerPlaceholder', () => {
  it('does not double punctuation after ? or !', () => {
    expect(composerPlaceholder('What next?')).toBe('What next? Enter to send, Shift+Enter for a new line.')
    expect(composerPlaceholder('Go!')).toBe('Go! Enter to send, Shift+Enter for a new line.')
  })
  it('adds a period otherwise', () => {
    expect(composerPlaceholder('Your reply')).toBe('Your reply. Enter to send, Shift+Enter for a new line.')
  })
})

describe('assistants edge cases', () => {
  it('names a missing quick info Scratch', () => {
    expect(quickFolderLabel(undefined)).toBe('Scratch')
  })
  it('a scratch chat never claims edits, and a folder chat without a name falls back to scratch wording', () => {
    expect(chatSummaryLine({ scratch: true, allowEdits: true, model: 'M' })).toContain('Reads files, asks before editing.')
    expect(chatSummaryLine({ scratch: false, allowEdits: false, model: 'M' })).toContain('Works in a private scratch area.')
    expect(chatSummaryLine({ scratch: false, folderName: 'api', allowEdits: false, model: '' })).toContain('Runs on the configured model.')
  })
  it('a quick run with a blank title proposes Chat, and no quick info cannot be promoted', () => {
    expect(promoteName({ quick: quick({ scratch: true }), title: '   ' })).toBe('Chat')
    expect(canPromote({}).ok).toBe(false)
  })
})
