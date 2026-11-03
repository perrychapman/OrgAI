import { describe, expect, it } from 'vitest'
import type { ConnectionInfo, Project } from '@shared/types'
import { isMeteredProject, projectMetering } from './limits'

const info = (connection: ConnectionInfo['connection']): ConnectionInfo => ({ connection, status: { state: 'connected' }, modelCount: 0, isDefault: false })
const anthropic = (kind: 'subscription' | 'apiKey'): ConnectionInfo =>
  info({ id: 'anthropic', enabled: true, tierModels: {}, auth: kind === 'apiKey' ? { kind, envVar: 'ANTHROPIC_API_KEY' } : { kind } })
const openai = (kind: 'chatgpt' | 'apiKey'): ConnectionInfo =>
  info({ id: 'openai', enabled: true, tierModels: {}, auth: kind === 'apiKey' ? { kind, envVar: 'OPENAI_API_KEY' } : { kind } })
const proj = (provider: Partial<Project['provider']>): Pick<Project, 'provider'> => ({ provider: { id: 'claude', label: 'x', auth: { kind: 'subscription' }, ...provider } })

describe('projectMetering', () => {
  it('treats LiteLLM as metered even before connections load', () => {
    expect(projectMetering(proj({ connection: 'litellm' }), null)).toBe('metered')
  })
  it('is unknown until the connection list is loaded', () => {
    expect(projectMetering(proj({ connection: 'anthropic' }), null)).toBe('unknown')
    expect(isMeteredProject(proj({ connection: 'anthropic' }), undefined)).toBe(false)
  })
  it('reads the auth kind of the project connection', () => {
    expect(projectMetering(proj({ connection: 'anthropic' }), [anthropic('subscription')])).toBe('subscription')
    expect(projectMetering(proj({ connection: 'anthropic' }), [anthropic('apiKey')])).toBe('metered')
    expect(projectMetering(proj({ id: 'codex', connection: 'openai' }), [openai('chatgpt')])).toBe('subscription')
    expect(projectMetering(proj({ id: 'codex', connection: 'openai' }), [openai('apiKey')])).toBe('metered')
  })
  it('follows the legacy connection fallback and counts the mock adapter on a login as subscription', () => {
    expect(projectMetering(proj({ id: 'codex' }), [anthropic('apiKey'), openai('chatgpt')])).toBe('subscription')
    expect(projectMetering(proj({ id: 'mock', connection: 'anthropic' }), [anthropic('subscription')])).toBe('subscription')
    expect(isMeteredProject(proj({ connection: 'litellm' }), [])).toBe(true)
  })
})
