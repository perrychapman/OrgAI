import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'
import { KNOWLEDGE_RECALL_TOKEN, MOCK_KNOWLEDGE_RECALLED, MockAdapter } from './mock'
import { RunManager } from './runManager'
import { RunStore } from '../store/runs'
import { knowledgeStore, saveNodeForUser } from '../store/knowledge'
import type { SetupService } from '../setup/service'
import { ROOT_AGENT_ID } from './types'
import { project } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-recall-')))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The mock adapter under the real RunManager and the real store: the counts and rows are RunManager's own. */
function rig() {
  const data = join(dir, 'data')
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const adapter = new MockAdapter({ script: { delayMs: 0 } })
  return new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(data), setup, () => 100, { dataDir: data, knowledge: knowledgeStore(data) })
}
const systemRows = (): { agentId: string; text: string }[] =>
  events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.source === 'harness' ? [{ agentId: e.entry.agentId, text: e.entry.block.text }] : []))
const texts = (): string[] => events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))

describe('[mock:knowledge-recall] under the real RunManager and store', () => {
  it('counts both recalls and the spawn block, writes the rows and says the sentence', async () => {
    const work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    const m = rig()
    // The automatic block only matches entities the USER created, so the person the report's brief names is the user's
    // own (seeded through the real store); the mock's later upsert of "Jane Doe" merges into it.
    saveNodeForUser(join(dir, 'data'), 'p1', { kind: 'person', name: 'Jane Doe' })
    const run = await m.start({ project: project({ id: 'p1', path: work, kind: 'engagement', isolateWriters: false }), prompt: `Check the billing ${KNOWLEDGE_RECALL_TOKEN}`, kind: 'work' })
    // The report's Edit then waits on a permission card nobody answers here, so the row is as far as this test goes.
    await vi.waitFor(() => expect(systemRows().some((r) => r.text.startsWith('Added '))).toBe(true), { timeout: 5000 })
    expect(texts()).toContain(MOCK_KNOWLEDGE_RECALLED)
    const recalled = systemRows().filter((r) => r.text.startsWith('Recalled '))
    expect(recalled).toHaveLength(2)
    expect(recalled.every((r) => r.agentId === ROOT_AGENT_ID)).toBe(true)
    // The spawn's row lands on the report, which exists by then (purpose 'spawn', with its id).
    expect(systemRows().find((r) => r.text === 'Added 1 known item: Jane Doe')?.agentId).toBe('mock-report-1')
    expect(m.summaryOf(run.id)?.usage?.knowledge).toMatchObject({ recalls: 2 })
    expect(m.summaryOf(run.id)?.usage?.knowledge?.autoContexts).toBeGreaterThanOrEqual(1)
    // The repeat is the dedupe path: the second answer says it was already shown.
    const results = events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [e.entry.block.content] : []))
    expect(results.filter((c) => c.includes('already shown')).length).toBeGreaterThanOrEqual(1)
    await m.stop(run.id)
  })

  it('an agent-created Jane Doe stays quiet: the report\'s brief gets no block and no "Added" row', async () => {
    const work = join(dir, 'work')
    mkdirSync(work, { recursive: true })
    const m = rig()
    const run = await m.start({ project: project({ id: 'p1', path: work, kind: 'engagement', isolateWriters: false }), prompt: `Check the billing ${KNOWLEDGE_RECALL_TOKEN}`, kind: 'work' })
    // The report reads a file only after it was spawned with its brief, so its result proves the spawn went through.
    await vi.waitFor(() => expect(events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'tool_result' && e.entry.block.content.includes('export const x'))).toBe(true), { timeout: 5000 })
    expect(texts()).toContain(MOCK_KNOWLEDGE_RECALLED)
    // Jane Doe exists (the mock wrote her as an agent) and the brief names her, but nothing was added.
    expect(systemRows().filter((r) => r.text.startsWith('Added '))).toEqual([])
    expect(m.summaryOf(run.id)?.usage?.knowledge?.autoContexts ?? 0).toBe(0)
    expect(systemRows().filter((r) => r.text.startsWith('Recalled '))).toHaveLength(2)
    await m.stop(run.id)
  })
})
