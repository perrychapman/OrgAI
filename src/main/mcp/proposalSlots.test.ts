/**
 * The one slot rule of approved MCP proposals (proposalSecrets.ts): the setup:decide storesSecret predicate prepares the
 * vault exactly when proposalTypedSlots is non-empty, and McpService.planProposalSecrets stores a subset of those slots.
 */
import { describe, expect, it } from 'vitest'
import type { McpServersProposalPayload, Proposal } from '@shared/types'
import { proposalSecretKey } from '@shared/types'
import { STORES_SECRET, type StoresSecretHostView } from '../host/storesSecret'
import { ProposalSecretsNotSaved, isProposalSecretSlot, proposalTypedSlots, proposalUpsertedIds, typedSlotValue } from './proposalSecrets'

const env = (serverId: string, name = 'TOKEN') => ({ serverId, kind: 'env' as const, name })
const header = (serverId: string, name = 'X-Key') => ({ serverId, kind: 'header' as const, name })
const payload = (upsertIds: string[], secrets: unknown[]): McpServersProposalPayload =>
  ({ scope: 'project', rationale: 'r', upsert: upsertIds.map((id) => ({ id, name: id, transport: 'stdio', command: 'npx', enabled: true, source: 'agent', addedAt: '' })), secrets }) as McpServersProposalPayload

describe('proposalSecrets slot rule', () => {
  it('keeps only well-formed slots of upserted servers with a usable value', () => {
    const p = payload(['s1', 's2'], [env('s1'), header('s2'), env('s3'), { serverId: 's1', kind: 'file', name: 'x' }, null, env('s2', 'EMPTY')])
    const values = {
      [proposalSecretKey(env('s1'))]: 'v1',
      [proposalSecretKey(header('s2'))]: 'h2',
      [proposalSecretKey(env('s3'))]: 'stray',
      [proposalSecretKey(env('s2', 'EMPTY'))]: ''
    }
    expect(proposalTypedSlots(p, values).map(({ slot, value }) => [proposalSecretKey(slot), value])).toEqual([
      ['s1:env:TOKEN', 'v1'],
      ['s2:header:X-Key', 'h2']
    ])
    expect([...proposalUpsertedIds(p)]).toEqual(['s1', 's2'])
    expect(isProposalSecretSlot({ serverId: 's1', kind: 'file', name: 'x' })).toBe(false)
    expect(typedSlotValue(header('s2'), { 's2:header:X-Key': 'a\nb' })).toBeUndefined()
    expect(typedSlotValue(env('s1'), { 's1:env:TOKEN': 'a\nb' })).toBe('a\nb')
    for (const odd of [undefined, null, 'x', ['v'], { 's1:env:TOKEN': 42 }]) expect(proposalTypedSlots(p, odd)).toEqual([])
  })

  it('the setup:decide predicate prepares exactly when the rule keeps a slot (never disagrees with the apply)', () => {
    const cases: Array<[McpServersProposalPayload, Record<string, string>]> = [
      [payload(['s1'], [env('s1')]), { 's1:env:TOKEN': 'v' }],
      [payload(['s1'], [env('s1'), env('s9')]), { 's9:env:TOKEN': 'v' }],
      [payload(['s1'], [header('s1')]), { 's1:header:X-Key': 'line\r\nbreak' }],
      [payload(['s1'], [header('s1')]), { 's1:header:X-Key': 'Bearer t' }],
      [payload([], [env('s1')]), { 's1:env:TOKEN': 'v' }],
      [payload(['s1'], [env('s1')]), { 's1:env:OTHER': 'v' }],
      [payload(['s1'], [env('s1')]), { 's1:env:TOKEN': '' }]
    ]
    for (const [p, values] of cases) {
      const card = { id: 'prop', runId: 'r', kind: 'mcpServers', title: 't', payload: p, createdAt: 0, revision: 1 } as unknown as Proposal
      const view: StoresSecretHostView = {
        project: () => null,
        libraryEntry: () => undefined,
        secretKeys: () => [],
        secretStatus: () => 'unset',
        pendingProposal: () => card
      }
      const prepares = STORES_SECRET['setup:decide']([{ runId: 'r', proposalId: 'prop', decision: { behavior: 'approve', secrets: values } }], view)
      expect(prepares, JSON.stringify(values)).toBe(proposalTypedSlots(p, values).length > 0)
    }
  })

  it('ProposalSecretsNotSaved carries the store reason once, without a doubled period', () => {
    expect(new ProposalSecretsNotSaved('The secret vault is locked: unlock it.').message).toBe('The secret values could not be saved: The secret vault is locked: unlock it')
  })
})
