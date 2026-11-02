import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServerSpec, McpServersProposalPayload } from '@shared/types'
import { proposalSecretKey } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { McpLibraryStore } from '../store/mcpLibrary'
import { McpService } from './service'

let dir: string
let store: ProjectStore
let mcp: McpService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-propsec-'))
  mkdirSync(join(dir, 'repo'))
  const data = join(dir, 'data')
  store = new ProjectStore(data)
  const secrets = new SecretStore(data, { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() })
  mcp = new McpService({ projects: store, secrets, library: new McpLibraryStore(data) })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const spec = (over: Partial<McpServerSpec>): McpServerSpec => ({
  id: 'mcp-1',
  name: 'gh',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'gh-mcp@1.2.3'],
  enabled: true,
  source: 'user',
  addedAt: '',
  ...over
})

describe('McpService.storeProposalSecrets', () => {
  it('stores only the payload slots on the project server and names servers still waiting', () => {
    const p = store.create({ name: 'X', path: join(dir, 'repo'), brief: '' })
    const gh = spec({ secretEnv: ['GH_TOKEN', 'GH_ORG'] })
    const db = spec({ id: 'mcp-2', name: 'db', args: ['-y', 'db-mcp@1.0.0'], secretHeaders: ['Authorization'], transport: 'http', command: undefined, url: 'https://db.test/mcp' })
    const payload: McpServersProposalPayload = {
      scope: 'project',
      upsert: [{ ...gh, projectOnly: true }, { ...db, projectOnly: true }],
      secrets: [
        { serverId: 'mcp-1', kind: 'env', name: 'GH_TOKEN' },
        { serverId: 'mcp-1', kind: 'env', name: 'GH_ORG' },
        { serverId: 'mcp-2', kind: 'header', name: 'Authorization' }
      ],
      rationale: 'r'
    }
    mcp.applyProposal(p.id, payload)
    const waiting = mcp.storeProposalSecrets(p.id, payload, {
      [proposalSecretKey({ serverId: 'mcp-1', kind: 'env', name: 'GH_TOKEN' })]: 't',
      [proposalSecretKey({ serverId: 'mcp-1', kind: 'env', name: 'GH_ORG' })]: 'o',
      // multi-line header values and keys naming no slot are ignored
      [proposalSecretKey({ serverId: 'mcp-2', kind: 'header', name: 'Authorization' })]: 'Bearer a\nX: b',
      'mcp-1:env:PATH': '/evil'
    })
    expect(waiting).toEqual(['db'])
    const saved = store.get(p.id)!
    expect(mcp.resolve(p.id, saved.mcpServers!.find((s) => s.id === 'mcp-1')!).env).toEqual({ GH_TOKEN: 't', GH_ORG: 'o' })
    expect(mcp.enabledServers(saved).map((s) => s.name)).toEqual(['gh'])
  })

  it('in a library session stores on the library entry', () => {
    const payload: McpServersProposalPayload = {
      scope: 'library',
      upsert: [spec({ id: 'mcpl-1', secretEnv: ['GH_TOKEN'] })],
      secrets: [{ serverId: 'mcpl-1', kind: 'env', name: 'GH_TOKEN' }],
      rationale: 'r'
    }
    mcp.applyLibraryProposal(payload)
    expect(mcp.storeProposalSecrets(null, payload, undefined)).toEqual(['gh'])
    expect(mcp.storeProposalSecrets(null, payload, { 'mcpl-1:env:GH_TOKEN': 'v' })).toEqual([])
  })
})

describe('McpService.applyProposal with projectOnly (work runs)', () => {
  it('never writes the library, even for a server that is not marked projectOnly', () => {
    const p = store.create({ name: 'X', path: join(dir, 'repo'), brief: '' })
    const payload: McpServersProposalPayload = { scope: 'project', upsert: [spec({ id: 'mcp-9', name: 'gone' })], rationale: 'r' }
    const saved = mcp.applyProposal(p.id, payload, { projectOnly: true })
    expect(mcp.libraryEntries()).toEqual([])
    expect(saved.mcpServers?.map((s) => [s.name, s.libraryId])).toEqual([['gone', undefined]])
    // Without the flag the same proposal goes to the library (setup and the assistant).
    const p2 = store.create({ name: 'Y', path: join(dir, 'repo'), brief: '' })
    mcp.applyProposal(p2.id, { ...payload, upsert: [spec({ id: 'mcp-10', name: 'shared' })] })
    expect(mcp.libraryEntries().map((e) => e.name)).toEqual(['shared'])
  })
})
