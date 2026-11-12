import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { officeAgentView } from './agentView'

const agent = (over: Partial<AgentInstance>): AgentInstance => ({ id: 'report', name: 'Worker', roleSlug: 'worker', parentId: 'root', state: 'done', activity: 'Reported back', result: '', ...over }) as AgentInstance

describe('office agent outcome parity', () => {
  it('preserves the graph no-result distinction even when adapter activity says Reported back', () => {
    expect(officeAgentView(agent({}))).toMatchObject({ status: 'done', statusLabel: 'Finished', activity: 'Ended without a result' })
    expect(officeAgentView(agent({ result: 'A real report' })).activity).toBe('Reported back')
  })
  it('keeps readable shared status words and root reply semantics', () => {
    expect(officeAgentView(agent({ state: 'error' })).statusLabel).toBe('Failed')
    expect(officeAgentView(agent({ state: 'tool' })).statusLabel).toBe('Running')
    expect(officeAgentView(agent({ state: 'waiting' })).statusLabel).toBe('Needs you')
    expect(officeAgentView(agent({ id: 'root', parentId: null, state: 'idle', activity: 'Waiting for you' })).activity).toBe('Waiting for your reply')
  })
})
