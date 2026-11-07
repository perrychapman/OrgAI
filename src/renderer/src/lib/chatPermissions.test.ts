import { describe, expect, it } from 'vitest'
import type { PermissionSuggestion } from '@shared/types'
import {
  chatAccessState,
  chatChangesHint,
  chatLocationLine,
  chatPlace,
  countsAsSessionChange,
  decisionLocationLabel,
  quickReadOnlyLine,
  runOnlyInstallTitle,
  scopeLimit,
  sessionScopeCopy
} from './chatPermissions'

const sessionEdit: PermissionSuggestion = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
const npmTest: PermissionSuggestion = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }

describe('chat place', () => {
  it('names the scratch area or the folder', () => {
    expect(chatPlace({ workingFolder: 'C:\\data\\quick\\quick_1', workingFolderScratch: true })).toEqual({ name: "this chat's scratch area", scratch: true })
    const p = chatPlace({ workingFolder: 'C:\\Users\\me\\notes-app' })
    expect(p?.name).toBe('notes-app')
    expect(p?.full).toBe('C:\\Users\\me\\notes-app')
    expect(chatLocationLine(p!)).toBe('Runs in notes-app')
    expect(chatPlace({})).toBeNull()
    expect(chatPlace({ workingFolder: '  ' })).toBeNull()
  })
  it('makes hidden characters visible', () => {
    expect(chatPlace({ workingFolder: '/home/me/a\u202eb' })?.name).toBe('a\\u202eb')
  })
})

describe('read-only line', () => {
  it('only for quickReadOnly', () => {
    expect(quickReadOnlyLine({ toolName: 'Edit', workingFolderScratch: true })).toBeNull()
  })
  it('edits name what they change, commands where they run', () => {
    expect(quickReadOnlyLine({ quickReadOnly: true, toolName: 'Edit', workingFolderScratch: true })).toBe('This chat started read-only. Allowing lets it change the scratch area.')
    expect(quickReadOnlyLine({ quickReadOnly: true, toolName: 'Write', workingFolder: '/x/notes-app' })).toBe('This chat started read-only. Allowing lets it change notes-app.')
    expect(quickReadOnlyLine({ quickReadOnly: true, toolName: 'Bash', workingFolder: '/x/notes-app' })).toBe('This chat started read-only. Allowing lets it run this command in notes-app.')
  })
})

describe('session scope copy', () => {
  it('chat edit offer', () => {
    expect(sessionScopeCopy([sessionEdit], true).session).toBe("Allow for session: stops asking for edits in this chat's folder until you end this chat.")
  })
  it('chat command rule', () => {
    expect(sessionScopeCopy([npmTest], true).session).toBe('Allow for session: stops asking for "npm test" commands until you end this chat.')
  })
  it('no suggestions, no session sentence; never a project sentence', () => {
    const c = sessionScopeCopy(undefined, true)
    expect(c).toEqual({ once: 'Allow once: this call only.' })
    expect(JSON.stringify(sessionScopeCopy([sessionEdit, npmTest], true))).not.toMatch(/project/)
  })
  it('a build session says session', () => {
    expect(sessionScopeCopy([npmTest], false).session).toMatch(/until you end this session\.$/)
  })
  it('scope limit', () => {
    expect(scopeLimit({})).toBe('project')
    expect(scopeLimit({ maxScope: 'session' })).toBe('session')
    expect(scopeLimit({ maxScope: 'once' })).toBe('once')
  })
})

describe('access chip', () => {
  it('states', () => {
    expect(chatAccessState({ allowEdits: false }, false)).toBe('asks')
    expect(chatAccessState({ allowEdits: true }, false)).toBe('edits')
    expect(chatAccessState({ allowEdits: false }, true)).toBe('session')
  })
  it('only write or command tools count', () => {
    expect(countsAsSessionChange('Edit', 'session')).toBe(true)
    expect(countsAsSessionChange('Bash', 'project')).toBe(true)
    expect(countsAsSessionChange('Bash', 'once')).toBe(false)
    expect(countsAsSessionChange('WebFetch', 'session')).toBe(false)
    expect(countsAsSessionChange(undefined, 'session')).toBe(false)
  })
})

describe('captions and copy', () => {
  it('decision location', () => {
    expect(decisionLocationLabel({ projectId: 'quick', quick: { folder: '/q/x', scratch: true, team: 'single', allowEdits: false, gitRepo: false } }, [])).toBe('Chat, scratch')
    expect(decisionLocationLabel({ projectId: 'quick', quick: { folder: '/me/notes-app', team: 'single', allowEdits: false, gitRepo: false } }, [])).toBe('Chat, notes-app')
    expect(decisionLocationLabel({ projectId: 'p1' }, [{ id: 'p1', name: 'Alpha' }])).toBe('Alpha')
  })
  it('hint and title', () => {
    expect(chatChangesHint(true)).toBe('Changes happen in a private scratch folder. You approve each one.')
    expect(chatChangesHint(false, 'notes-app')).toBe('Changes happen in notes-app. You approve each one.')
    expect(runOnlyInstallTitle('mock-notes')).toBe('Add a server: mock-notes')
  })
})
