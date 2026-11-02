import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))

const { CONNECTOR_TOKEN_MAX_CHARS, PICKED_FOLDERS_PER_SENDER, PickedFolders, connectorArgs, proposalDecideArgs, PROPOSAL_SECRETS_MAX } = await import('./ipc')

describe('connectorArgs', () => {
  it('rebuilds connectors:add with only the id and variant', () => {
    expect(connectorArgs.add({ connectorId: 'context7', variant: 'key', url: 'https://evil.example', headers: { a: 'b' } })).toEqual({ connectorId: 'context7', variant: 'key' })
    expect(connectorArgs.add({ connectorId: 'microsoft-learn' })).toEqual({ connectorId: 'microsoft-learn' })
  })

  it('refuses a malformed add', () => {
    for (const bad of [null, undefined, 'gmail', 42, [], {}, { connectorId: 7 }, { connectorId: '' }, { connectorId: 'Gmail' }, { connectorId: '../x' }, { connectorId: '-x' }, { connectorId: 'a'.repeat(65) }]) {
      expect(() => connectorArgs.add(bad), JSON.stringify(bad)).toThrow('Unknown connector.')
    }
    for (const variant of [null, 3, '', 'Key', 'a b', 'x'.repeat(65)]) {
      expect(() => connectorArgs.add({ connectorId: 'exa', variant }), String(variant)).toThrow('Unknown connector variant.')
    }
  })

  it('rebuilds connectors:setToken with a bounded token or null', () => {
    expect(connectorArgs.setToken({ connectorId: 'zapier', token: 'abc', extra: 1 })).toEqual({ connectorId: 'zapier', token: 'abc' })
    expect(connectorArgs.setToken({ connectorId: 'zapier', token: null })).toEqual({ connectorId: 'zapier', token: null })
    expect(connectorArgs.setToken({ connectorId: 'zapier', token: 'x'.repeat(CONNECTOR_TOKEN_MAX_CHARS) }).token).toHaveLength(4000)
  })

  it('refuses a malformed setToken', () => {
    expect(() => connectorArgs.setToken({ connectorId: 'zapier', token: 'x'.repeat(CONNECTOR_TOKEN_MAX_CHARS + 1) })).toThrow('too long')
    for (const token of [undefined, 5, {}, ['a']]) expect(() => connectorArgs.setToken({ connectorId: 'zapier', token })).toThrow('must be text')
    expect(() => connectorArgs.setToken({ connectorId: 'ZAPIER', token: 'a' })).toThrow('Unknown connector.')
    expect(() => connectorArgs.setToken(null)).toThrow('Unknown connector.')
  })
})

describe('PickedFolders', () => {
  it('accepts a folder once, only from the renderer that picked it', () => {
    const p = new PickedFolders()
    p.remember(1, 'C:\\skills\\a')
    expect(p.take(2, 'C:\\skills\\a')).toBe(false)
    expect(p.take(1, 'C:\\skills\\b')).toBe(false)
    expect(p.take(1, 'C:\\skills\\a')).toBe(true)
    expect(p.take(1, 'C:\\skills\\a')).toBe(false)
  })

  it('keeps at most the newest folders per renderer and forgets a destroyed renderer', () => {
    const p = new PickedFolders()
    for (let i = 0; i <= PICKED_FOLDERS_PER_SENDER; i++) p.remember(1, `/f${i}`)
    p.remember(1, '/f1') // re-picking moves it to the newest end
    expect(p.take(1, '/f0')).toBe(false)
    expect(p.take(1, '/f1')).toBe(true)
    expect(p.take(1, `/f${PICKED_FOLDERS_PER_SENDER}`)).toBe(true)
    p.remember(3, '/x')
    p.forget(3)
    expect(p.take(3, '/x')).toBe(false)
  })
})

describe('proposalDecideArgs (setup:decide)', () => {
  const head = { runId: 'r1', proposalId: 'p1' }
  it('rebuilds each decision and drops extra fields', () => {
    expect(proposalDecideArgs({ ...head, extra: 1, decision: { behavior: 'approve', spec: {} } })).toEqual({ ...head, decision: { behavior: 'approve' } })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: { 'mcp-1:env:TOKEN': 'v', 'mcp-1:env:EMPTY': '' } } })).toEqual({
      ...head,
      decision: { behavior: 'approve', secrets: { 'mcp-1:env:TOKEN': 'v' } }
    })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'revise', feedback: 'f', secrets: { a: 'b' } } })).toEqual({ ...head, decision: { behavior: 'revise', feedback: 'f' } })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'decline', note: ' no ' } })).toEqual({ ...head, decision: { behavior: 'decline', note: 'no' } })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'decline' } })).toEqual({ ...head, decision: { behavior: 'decline' } })
  })
  it('refuses wrong shapes', () => {
    for (const bad of [null, 'x', [], { ...head }, { ...head, decision: 'approve' }, { ...head, decision: { behavior: 'allow' } }, { runId: 1, proposalId: 'p', decision: { behavior: 'approve' } }]) {
      expect(() => proposalDecideArgs(bad)).toThrow()
    }
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'revise' } })).toThrow('must be text')
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'revise', feedback: 'x'.repeat(5000) } })).toThrow('too long')
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: ['a'] } })).toThrow()
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: { a: 1 } } })).toThrow('must be text')
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: { a: 'x'.repeat(4001) } } })).toThrow('too long')
    const many = Object.fromEntries(Array.from({ length: PROPOSAL_SECRETS_MAX + 1 }, (_, i) => ['k' + i, 'v']))
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: many } })).toThrow('At most')
  })
})
