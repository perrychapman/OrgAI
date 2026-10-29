import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { HandleNamer, MESSAGE_PREVIEW_CHARS, mapSendMessage, messageTranscriptText, readSendMessage, resolveRecipient, spawnHandle } from './network'

function agent(over: Partial<AgentInstance> & { id: string; roleSlug: string }): AgentInstance {
  return {
    roleId: null,
    name: over.roleSlug,
    parentId: 'root',
    spawnToolUseId: null,
    state: 'thinking',
    activity: '',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: 0,
    ...over
  }
}

describe('HandleNamer and spawnHandle', () => {
  it('numbers handles per role slug in spawn order', () => {
    const n = new HandleNamer()
    expect(n.next('implementer')).toBe('implementer-1')
    expect(n.next('implementer')).toBe('implementer-2')
    expect(n.next('reviewer')).toBe('reviewer-1')
    expect(n.next('implementer')).toBe('implementer-3')
  })

  it('keeps a name the model chose and never hands it out again', () => {
    const n = new HandleNamer()
    expect(spawnHandle(n, 'implementer', ' implementer-2 ')).toEqual({ handle: 'implementer-2', generated: false })
    expect(spawnHandle(n, 'implementer', undefined)).toEqual({ handle: 'implementer-1', generated: true })
    expect(spawnHandle(n, 'implementer', '')).toEqual({ handle: 'implementer-3', generated: true })
    expect(spawnHandle(n, 'implementer', 42)).toEqual({ handle: 'implementer-4', generated: true })
  })

  it('falls back to "agent" for an empty slug', () => {
    expect(new HandleNamer().next('  ')).toBe('agent-1')
  })
})

describe('readSendMessage', () => {
  it('reads the address and a plain or structured message', () => {
    expect(readSendMessage({ to: 'implementer-2', message: 'The API is   ready.' })).toEqual({ toHandle: 'implementer-2', text: 'The API is ready.' })
    expect(readSendMessage({ to: 'lead', message: { type: 'note', text: 'Done' } })).toEqual({ toHandle: 'lead', text: 'Done' })
    expect(readSendMessage({ recipient: 'x', summary: 'short' })).toEqual({ toHandle: 'x', text: 'short' })
  })

  it('caps the text and rejects calls without an address', () => {
    expect(readSendMessage({ to: 'a', message: 'y'.repeat(500) })?.text).toHaveLength(MESSAGE_PREVIEW_CHARS)
    expect(readSendMessage({ message: 'hi' })).toBeNull()
    expect(readSendMessage({ to: '  ' })).toBeNull()
    expect(readSendMessage(null)).toBeNull()
  })
})

describe('resolveRecipient', () => {
  const agents = [
    agent({ id: 'root', roleSlug: 'lead', parentId: null }),
    agent({ id: 'a1', roleSlug: 'implementer', handle: 'implementer-1', startedAt: 1, state: 'done' }),
    agent({ id: 'a2', roleSlug: 'implementer', handle: 'implementer-2', startedAt: 2 }),
    agent({ id: 'a3', roleSlug: 'reviewer', handle: 'reviewer-1', startedAt: 3, state: 'done' })
  ]

  it('matches an exact handle first, case-insensitively', () => {
    expect(resolveRecipient('implementer-1', agents)).toBe('a1')
    expect(resolveRecipient('Implementer-2', agents)).toBe('a2')
  })

  it('falls back to a role slug, preferring a running agent', () => {
    expect(resolveRecipient('implementer', agents)).toBe('a2')
    expect(resolveRecipient('reviewer', agents)).toBe('a3')
    expect(resolveRecipient('lead', agents)).toBe('root')
    expect(resolveRecipient('main', agents)).toBe('root')
  })

  it('returns null for the user, unknown addresses and the sender itself', () => {
    expect(resolveRecipient('user', agents)).toBeNull()
    expect(resolveRecipient('nobody', agents)).toBeNull()
    expect(resolveRecipient('implementer-2', agents, 'a2')).toBeNull()
  })
})

describe('mapSendMessage', () => {
  it('builds the normalized message and its transcript line', () => {
    const agents = [agent({ id: 'root', roleSlug: 'lead', parentId: null }), agent({ id: 'a2', roleSlug: 'implementer', handle: 'implementer-2' })]
    const m = mapSendMessage('a2', { to: 'lead', message: 'Interface is in src/api.ts' }, agents, 123)
    expect(m).toEqual({ from: 'a2', to: 'root', toHandle: 'lead', text: 'Interface is in src/api.ts', at: 123 })
    expect(messageTranscriptText(m!)).toBe('→ lead: Interface is in src/api.ts')
    expect(mapSendMessage('root', { to: 'user', message: 'hi' }, agents, 1)).toEqual({ from: 'root', to: null, toHandle: 'user', text: 'hi', at: 1 })
    expect(mapSendMessage('root', {}, agents)).toBeNull()
  })
})
