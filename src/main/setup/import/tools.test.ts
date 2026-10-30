import { describe, expect, it } from 'vitest'
import { mapTools, rooGroupTools } from './tools'

describe('mapTools', () => {
  it('defaults when no list is given', () => {
    expect(mapTools(undefined)).toEqual({ tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], dropped: [], canSpawn: false })
  })
  it('maps foreign names case-insensitively in catalog order', () => {
    const r = mapTools(['run_shell_command', 'READ_FILE', 'edit', 'search', 'web', 'todo', 'google_web_search', 'MultiEdit'])
    expect(r.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite'])
    expect(r.dropped).toEqual([])
  })
  it('strips permission patterns, detects spawn, drops unknown and mcp names', () => {
    const r = mapTools(['Bash(git:*)', 'Task', 'mcp__github__issues', 'Foo', 'Foo', 'NotebookEdit', 'SendMessage', 'ListAgents'])
    expect(r.tools).toEqual(['Bash', 'NotebookEdit', 'SendMessage', 'ListAgents'])
    expect(r.canSpawn).toBe(true)
    expect(r.dropped).toEqual(['mcp__github__issues', 'Foo'])
  })
  it('removes denied tools', () => {
    expect(mapTools(undefined, ['edit', 'bash']).tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(mapTools(['Read', 'Write', 'Edit'], ['write']).tools).toEqual(['Read', 'Edit'])
    expect(mapTools(['Read', 'Agent'], ['task']).canSpawn).toBe(false)
  })
})

describe('rooGroupTools', () => {
  it('maps groups and tuples; mcp gives nothing', () => {
    const raw = rooGroupTools(['read', ['edit', { fileRegex: 'x' }], 'command', 'browser', 'mcp'])
    expect(raw).toEqual(['read', 'glob', 'grep', 'edit', 'write', 'bash', 'webfetch'])
    expect(mapTools(raw).tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch'])
    expect(rooGroupTools(undefined)).toEqual([])
  })
})

describe('mapTools with hostile names', () => {
  it('treats Object.prototype member names as unknown tools instead of throwing', () => {
    const r = mapTools(['constructor', '__proto__', 'toString', 'read'], ['constructor', '__proto__', 'hasOwnProperty'])
    expect(r.tools).toEqual(['Read'])
    expect(r.dropped).toEqual(['constructor', '__proto__', 'toString'])
  })
})
