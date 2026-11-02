import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent, TranscriptBlock } from '@shared/types'
import { RunManager } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { MCP_MIDRUN_TOKEN, MOCK_MIDRUN_REPORT, MOCK_MIDRUN_SERVER, MOCK_MIDRUN_TOOL, MockAdapter } from './mock'
import { ROOT_AGENT_ID } from './types'
import { project as makeProject } from './testHelpers'

// End to end on the mock adapter through RunManager: request_mcp_install approved mid-run, the server joins the run,
// granted roles call it right away (through the permission card), a role the install card left out is denied.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcp-midrun-'))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rig() {
  const store = new RunStore(join(dir, 'data'))
  const setup = { hiddenContext: vi.fn(() => ''), markArchitectureUpdated: vi.fn() } as unknown as SetupService
  const adapter = new MockAdapter({ script: { delayMs: 0 } })
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100)
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  return { m, adapter, p: makeProject({ path: repo, autoContinue: false }) }
}

async function next<K extends RunEvent['type']>(type: K, pred: (e: Extract<RunEvent, { type: K }>) => boolean = () => true): Promise<Extract<RunEvent, { type: K }>> {
  let hit: Extract<RunEvent, { type: K }> | undefined
  await vi.waitFor(() => {
    hit = events.find((e): e is Extract<RunEvent, { type: K }> => e.type === type && pred(e as Extract<RunEvent, { type: K }>))
    expect(hit).toBeDefined()
  })
  return hit!
}

const rows = (runId: string): { agentId: string; block: TranscriptBlock }[] =>
  events.flatMap((e) => (e.type === 'transcript' && e.runId === runId ? [{ agentId: e.entry.agentId, block: e.entry.block }] : []))

/** The tool_result an agent got for its call of `tool` (matched through the tool_use id). */
function resultOf(runId: string, agentId: string, tool: string): Extract<TranscriptBlock, { kind: 'tool_result' }> | undefined {
  const all = rows(runId)
  const use = all.find((r) => r.agentId === agentId && r.block.kind === 'tool_use' && r.block.name === tool)
  if (!use || use.block.kind !== 'tool_use') return undefined
  const id = use.block.id
  return all.map((r) => r.block).find((b): b is Extract<TranscriptBlock, { kind: 'tool_result' }> => b.kind === 'tool_result' && b.toolUseId === id)
}

const used = (runId: string) => (e: Extract<RunEvent, { type: 'transcript' }>) => e.runId === runId && e.entry.block.kind === 'text' && e.entry.block.text.includes('the new MCP server was used')

describe('request_mcp_install mid-run (RunManager + mock)', () => {
  it('a card that restricts roles: the root uses the server at once, a report outside the roles is denied', async () => {
    const { m, adapter, p } = rig()
    const run = await m.start({ project: p, prompt: `Work that needs a new server ${MCP_MIDRUN_TOKEN}` })
    const install = await next('mcpInstall.request', (e) => e.runId === run.id)
    expect(install.request.spec).toMatchObject({ name: MOCK_MIDRUN_SERVER, source: 'agent' })
    m.answerMcpInstall(run.id, install.request.id, { approved: true, scope: 'run', spec: { ...install.request.spec, roles: ['lead'] } })

    // The root's call reaches the permission card (approval never auto-allows the server's tools).
    const card = await next('permission.request', (e) => e.runId === run.id && e.request.toolName === MOCK_MIDRUN_TOOL)
    expect(card.request.agentId).toBe(ROOT_AGENT_ID)
    m.decide(run.id, card.request.id, { behavior: 'allow' })
    await next('transcript', used(run.id))

    const installText = resultOf(run.id, ROOT_AGENT_ID, 'request_mcp_install')?.content ?? ''
    expect(installText.startsWith(`The user approved installing ${MOCK_MIDRUN_SERVER} for this run.`)).toBe(true)
    expect(resultOf(run.id, ROOT_AGENT_ID, MOCK_MIDRUN_TOOL)).toMatchObject({ content: 'PONG', isError: false })
    const denied = resultOf(run.id, MOCK_MIDRUN_REPORT, MOCK_MIDRUN_TOOL)
    expect(denied?.isError).toBe(true)
    expect(denied?.content).toBe(`The org chart does not grant the MCP server "${MOCK_MIDRUN_SERVER}" to the Engineer role (engineer). Hand this step to an agent whose role has it, or ask the user to grant it.`)
    // Only the root's call ever asked the user.
    expect(events.filter((e) => e.type === 'permission.request' && e.runId === run.id)).toHaveLength(1)
    const session = adapter.sessions[0]!
    expect(session.addedMcpServers.map((s) => s.name)).toEqual([MOCK_MIDRUN_SERVER])
    expect(session.mcpServersByRole).toEqual({ lead: [MOCK_MIDRUN_SERVER], engineer: [], reviewer: [] })
    await m.stopAll()
  })

  it('a card that keeps every role: the report spawned after the install uses it too', async () => {
    const { m, p } = rig()
    const run = await m.start({ project: p, prompt: `Work that needs a new server ${MCP_MIDRUN_TOKEN}` })
    const install = await next('mcpInstall.request', (e) => e.runId === run.id)
    m.answerMcpInstall(run.id, install.request.id, { approved: true, scope: 'run' })
    const rootCard = await next('permission.request', (e) => e.runId === run.id && e.request.agentId === ROOT_AGENT_ID)
    m.decide(run.id, rootCard.request.id, { behavior: 'allow' })
    const reportCard = await next('permission.request', (e) => e.runId === run.id && e.request.agentId === MOCK_MIDRUN_REPORT)
    expect(reportCard.request.toolName).toBe(MOCK_MIDRUN_TOOL)
    m.decide(run.id, reportCard.request.id, { behavior: 'allow' })
    await next('transcript', used(run.id))
    expect(resultOf(run.id, MOCK_MIDRUN_REPORT, MOCK_MIDRUN_TOOL)).toMatchObject({ content: 'PONG', isError: false })
    await m.stopAll()
  })

  it('a denied install leaves the server unknown: both calls get the gate denial and nothing asks the user', async () => {
    const { m, p } = rig()
    const run = await m.start({ project: p, prompt: `Work that needs a new server ${MCP_MIDRUN_TOKEN}` })
    const install = await next('mcpInstall.request', (e) => e.runId === run.id)
    m.answerMcpInstall(run.id, install.request.id, { approved: false, scope: 'run', note: 'not today' })
    await next('transcript', used(run.id))
    expect(resultOf(run.id, ROOT_AGENT_ID, 'request_mcp_install')?.content).toContain('The user denied installing this server.')
    expect(resultOf(run.id, ROOT_AGENT_ID, MOCK_MIDRUN_TOOL)?.content).toBe(`The MCP server "${MOCK_MIDRUN_SERVER}" is not configured for this run.`)
    expect(events.some((e) => e.type === 'permission.request')).toBe(false)
    await m.stopAll()
  })
})

