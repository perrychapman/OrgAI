import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KNOWLEDGE_FACT_MAX_CHARS, KNOWLEDGE_NODE_FACTS_MAX, type KnowledgeSource } from '@shared/types'

// knowledgeArgs lives in ipc.ts, which imports electron: the ipc*.test.ts mocking pattern.
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
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '' }))

const { STALE_NODE_MESSAGE, knowledgeFile, readKnowledge, saveNodeForUser, upsertNode } = await import('./knowledge')
const { knowledgeArgs } = await import('../ipc')

let dir: string
const P = 'proj_a'
const agent: KnowledgeSource = { by: 'agent', at: 1000, runId: 'run_1', agentId: 'agent_1', role: 'Analyst' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-kg-append-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fileText = (): string => readFileSync(knowledgeFile(dir, P), 'utf8')
const errorOf = (fn: () => unknown): (Error & { code?: string }) | undefined => {
  try {
    fn()
  } catch (e) {
    return e as Error & { code?: string }
  }
  return undefined
}

describe('saveNodeForUser appendFacts', () => {
  it('appends deduplicated user facts to an existing node and keeps agent facts and their sources', () => {
    const { node } = upsertNode(dir, P, { kind: 'person', name: 'Jane Doe', facts: ['Works at Acme'] }, agent)
    const saved = saveNodeForUser(dir, P, { nodeId: node.id, kind: 'person', name: 'Jane Doe', appendFacts: ['works at acme', 'Likes tea', 'Likes  TEA', 'Speaks French'] })
    expect(saved.facts.map((f) => f.text)).toEqual(['Works at Acme', 'Likes tea', 'Speaks French'])
    expect(saved.facts[0].source).toEqual(agent)
    expect(saved.facts[0].id).toBe(node.facts[0].id)
    for (const f of saved.facts.slice(1)) {
      expect(f.source.by).toBe('user')
      expect(f.id).toMatch(/^kf_/)
    }
    expect(new Set(saved.facts.map((f) => f.id)).size).toBe(3)
    expect(readKnowledge(dir, P).nodes[0].facts).toEqual(saved.facts)
  })

  it('appends to a retired fact text as a new live fact', () => {
    const created = saveNodeForUser(dir, P, { kind: 'system', name: 'Billing', facts: [{ text: 'Old', retired: true }] })
    const saved = saveNodeForUser(dir, P, { nodeId: created.id, kind: 'system', name: 'Billing', appendFacts: ['Old'] })
    expect(saved.facts.map((f) => [f.text, !!f.retired])).toEqual([
      ['Old', true],
      ['Old', false]
    ])
  })

  it('works on a new node', () => {
    const node = saveNodeForUser(dir, P, { kind: 'organisation', name: 'Acme', appendFacts: ['HQ in Leeds', 'hq in leeds', 'FY ends March'] })
    expect(node.facts.map((f) => f.text)).toEqual(['HQ in Leeds', 'FY ends March'])
    expect(node.facts.every((f) => f.source.by === 'user')).toBe(true)
    expect(readKnowledge(dir, P).nodes).toHaveLength(1)
  })

  it('applies facts first, then the appended ones', () => {
    const created = saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', facts: [{ text: 'A' }, { text: 'B' }] })
    const saved = saveNodeForUser(dir, P, { nodeId: created.id, kind: 'person', name: 'Ada', facts: [{ id: created.facts[1].id, text: 'B' }, { text: 'C' }], appendFacts: ['A', 'b', 'D'] })
    // 'A' was removed by the facts list, so it is appended again; 'b' is already there as 'B'.
    expect(saved.facts.map((f) => f.text)).toEqual(['B', 'C', 'A', 'D'])
    expect(saved.facts[0].id).toBe(created.facts[1].id)
    const fresh = saveNodeForUser(dir, P, { kind: 'person', name: 'Bo', facts: [{ text: 'X' }], appendFacts: ['x', 'Y'] })
    expect(fresh.facts.map((f) => f.text)).toEqual(['X', 'Y'])
  })

  it('enforces the fact cap with nothing written', () => {
    const facts = Array.from({ length: KNOWLEDGE_NODE_FACTS_MAX - 1 }, (_, i) => `Fact ${i}`)
    const created = saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', appendFacts: facts })
    expect(created.facts).toHaveLength(KNOWLEDGE_NODE_FACTS_MAX - 1)
    const before = fileText()
    expect(() => saveNodeForUser(dir, P, { nodeId: created.id, kind: 'person', name: 'Ada', appendFacts: ['New 1', 'New 2'] })).toThrow(new RegExp(`at most ${KNOWLEDGE_NODE_FACTS_MAX} facts`))
    expect(fileText()).toBe(before)
    // Duplicates do not count against the cap.
    expect(saveNodeForUser(dir, P, { nodeId: created.id, kind: 'person', name: 'Ada', appendFacts: ['Fact 0', 'New 1'] }).facts).toHaveLength(KNOWLEDGE_NODE_FACTS_MAX)
    const tooMany = Array.from({ length: KNOWLEDGE_NODE_FACTS_MAX + 1 }, (_, i) => `F${i}`)
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'Bo', appendFacts: tooMany })).toThrow(/at most/)
  })

  it('validates each appended text', () => {
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', appendFacts: [''] })).toThrow(/empty/)
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', appendFacts: ['x'.repeat(KNOWLEDGE_FACT_MAX_CHARS + 1)] })).toThrow(/longer than/)
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', appendFacts: ['a‮b'] })).toThrow(/hidden character/)
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', appendFacts: 'x' as unknown as string[] })).toThrow(/list/)
    expect(readKnowledge(dir, P).nodes).toEqual([])
  })
})

describe('saveNodeForUser expectedUpdatedAt', () => {
  it('saves when it matches and refuses a stale one with code "stale" and nothing written', () => {
    const created = saveNodeForUser(dir, P, { kind: 'person', name: 'Ada' })
    const saved = saveNodeForUser(dir, P, { nodeId: created.id, kind: 'person', name: 'Ada', expectedUpdatedAt: created.updatedAt, appendFacts: ['A'] })
    expect(saved.facts.map((f) => f.text)).toEqual(['A'])
    const before = fileText()
    const err = errorOf(() => saveNodeForUser(dir, P, { nodeId: created.id, kind: 'person', name: 'Ada', expectedUpdatedAt: saved.updatedAt - 1, appendFacts: ['B'] }))
    expect(err?.code).toBe('stale_revision')
    expect(err?.message).toBe(STALE_NODE_MESSAGE)
    expect(err?.message).toBe('This item changed since you opened it. Reload it and try again.')
    expect(fileText()).toBe(before)
  })

  it('goes stale after an agent write in between', () => {
    const created = saveNodeForUser(dir, P, { kind: 'person', name: 'Ada' })
    const opened = created.updatedAt
    // An agent write moves updatedAt (make sure the clock moved).
    const realNow = Date.now
    Date.now = () => opened + 5
    try {
      upsertNode(dir, P, { nodeId: created.id, kind: 'person', name: 'Ada', facts: ['From an agent'] }, agent)
    } finally {
      Date.now = realNow
    }
    const err = errorOf(() => saveNodeForUser(dir, P, { nodeId: created.id, kind: 'person', name: 'Ada', expectedUpdatedAt: opened, appendFacts: ['Mine'] }))
    expect(err?.code).toBe('stale_revision')
    expect(readKnowledge(dir, P).nodes[0].facts.map((f) => f.text)).toEqual(['From an agent'])
  })

  it('is refused without a nodeId or when not a finite number', () => {
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', expectedUpdatedAt: 1 })).toThrow(/needs the nodeId/)
    const created = saveNodeForUser(dir, P, { kind: 'person', name: 'Bo' })
    expect(() => saveNodeForUser(dir, P, { nodeId: created.id, kind: 'person', name: 'Bo', expectedUpdatedAt: Number.NaN })).toThrow(/finite/)
    expect(readKnowledge(dir, P).nodes.map((n) => n.name)).toEqual(['Bo'])
  })
})

describe('knowledgeArgs.saveNode appendFacts / expectedUpdatedAt', () => {
  const base = { projectId: 'proj_a', kind: 'person', name: 'Ada' }
  it('passes them through', () => {
    expect(knowledgeArgs.saveNode({ ...base, nodeId: 'kn_ab12', appendFacts: ['A', 'B'], expectedUpdatedAt: 123 })).toEqual({ ...base, nodeId: 'kn_ab12', appendFacts: ['A', 'B'], expectedUpdatedAt: 123 })
    expect(knowledgeArgs.saveNode({ ...base, appendFacts: null, expectedUpdatedAt: null })).toEqual(base)
  })
  it('refuses bad shapes', () => {
    const bad: unknown[] = [
      { ...base, appendFacts: 'A' },
      { ...base, appendFacts: [1] },
      { ...base, appendFacts: ['x'.repeat(KNOWLEDGE_FACT_MAX_CHARS + 1)] },
      { ...base, appendFacts: Array.from({ length: KNOWLEDGE_NODE_FACTS_MAX + 1 }, () => 'a') },
      { ...base, expectedUpdatedAt: '1' },
      { ...base, expectedUpdatedAt: Number.POSITIVE_INFINITY },
      { ...base, expectedUpdatedAt: Number.NaN }
    ]
    for (const input of bad) expect(() => knowledgeArgs.saveNode(input), JSON.stringify(input)).toThrow()
  })
})
